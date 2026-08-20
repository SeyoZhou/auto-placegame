import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../lib/placegame-api.mjs";
import { executeWorldBossSession } from "../lib/placegame-world-boss.mjs";

test("world boss session submits one assist per boss and account with at most three accounts in flight", async () => {
  let inFlight = 0;
  let maximumInFlight = 0;
  const order = [];
  const clients = ["a", "b", "c", "d"].map((alias) => fakeClient(alias, {
    low: 3,
    high: 3
  }, {
    onAssist: async (bossKey) => {
      order.push(`${bossKey}:${alias}`);
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
    }
  }));
  const state = { version: 1, accounts: {} };

  const result = await executeWorldBossSession({
    clients,
    event: { id: "2026-08-18@16:00" },
    state,
    saveState: async () => {},
    concurrency: 3
  });

  assert.equal(maximumInFlight, 3);
  assert.equal(order.length, 8);
  assert.equal(order.slice(0, 4).every((entry) => entry.startsWith("low:")), true);
  assert.equal(order.slice(4).every((entry) => entry.startsWith("high:")), true);
  assert.equal(result.completed, true);
  for (const client of clients) {
    assert.equal(client.counts.low, 2);
    assert.equal(client.counts.high, 2);
  }
});

test("world boss session refreshes after every assist and isolates an ambiguous pair", async () => {
  const uncertain = fakeClient("uncertain", { low: 3, high: 1 }, {
    ambiguousBoss: "low"
  });
  const healthy = fakeClient("healthy", { low: 2, high: 1 });
  const state = { version: 1, accounts: {} };

  const result = await executeWorldBossSession({
    clients: [uncertain, healthy],
    event: { id: "2026-08-18@16:00" },
    state,
    saveState: async () => {}
  });

  assert.equal(uncertain.counts.low, 3);
  assert.equal(uncertain.counts.high, 0);
  assert.equal(healthy.counts.low, 1);
  assert.equal(healthy.counts.high, 0);
  assert.equal(uncertain.posts.filter((entry) => entry === "low").length, 1);
  assert.equal(result.reports.get("uncertain").actions.some((action) => action.status === "uncertain"), true);
  assert.equal(state.worldBoss.events["2026-08-18@16:00"].accounts.uncertain.pairs["low:low-instance"].status, "uncertain");

  const resumed = await executeWorldBossSession({
    clients: [uncertain],
    event: { id: "2026-08-18@16:00" },
    state,
    saveState: async () => {}
  });
  assert.equal(resumed.completed, false);
  assert.deepEqual(resumed.unresolvedAliases, ["uncertain"]);
  assert.equal(uncertain.posts.filter((entry) => entry === "low").length, 1);
});

test("world boss session persists the one-submission pair limit", async () => {
  const client = fakeClient("single", { low: 3, high: 3 });
  const state = { version: 1, accounts: {} };
  const event = { id: "2026-08-18@16:00" };

  await executeWorldBossSession({ clients: [client], event, state, saveState: async () => {} });
  await executeWorldBossSession({ clients: [client], event, state, saveState: async () => {} });

  assert.deepEqual(client.posts, ["low", "high"]);
  assert.equal(state.worldBoss.events[event.id].accounts.single.pairs["low:low-instance"].attempts, 1);
  assert.equal(state.worldBoss.events[event.id].accounts.single.pairs["high:high-instance"].attempts, 1);
});

test("world boss persists the pair submission marker before sending the assist", async () => {
  const state = { version: 1, accounts: {} };
  const event = { id: "2026-08-18@16:00" };
  const timeline = [];
  const client = fakeClient("ordered", { low: 3 }, {
    onAssist: async () => timeline.push("assist")
  });

  await executeWorldBossSession({
    clients: [client],
    event,
    state,
    saveState: async () => {
      const marker = state.worldBoss.events[event.id].accounts.ordered?.pairs?.["low:low-instance"]?.submissionStarted;
      timeline.push(marker === true ? "save-marker" : "save");
    }
  });

  assert.equal(timeline.indexOf("save-marker") < timeline.indexOf("assist"), true);
});

test("world boss retries a definitively rejected assist after a confirmed unchanged refresh", async () => {
  const client = fakeClient("retry", { low: 3, high: 3 }, { rejectOnceBoss: "low" });
  const state = { version: 1, accounts: {} };
  const event = { id: "2026-08-18@16:00" };

  const first = await executeWorldBossSession({ clients: [client], event, state, saveState: async () => {} });
  assert.deepEqual(first.unresolvedAliases, ["retry"]);
  assert.equal(state.worldBoss.events[event.id].accounts.retry.pairs["low:low-instance"].submissionStarted, undefined);

  const second = await executeWorldBossSession({ clients: [client], event, state, saveState: async () => {} });
  assert.equal(second.completed, true);
  assert.deepEqual(client.posts, ["low", "high", "low"]);
});

test("world boss session does not repeat an interrupted pair and continues other bosses", async () => {
  const client = fakeClient("restart", { low: 3, high: 3 });
  const event = { id: "2026-08-18@16:00" };
  const state = {
    version: 1,
    accounts: {},
    worldBoss: {
      events: {
        [event.id]: {
          status: "incomplete",
          accounts: {
            restart: {
              pairs: {
                "low:low-instance": {
                  status: "in-progress",
                  bossKey: "low",
                  instanceId: "low-instance",
                  attempts: 0,
                  submissionStarted: true
                }
              }
            }
          }
        }
      }
    }
  };

  const result = await executeWorldBossSession({ clients: [client], event, state, saveState: async () => {} });

  assert.deepEqual(client.posts, ["high"]);
  assert.deepEqual(result.unresolvedAliases, ["restart"]);
  assert.equal(result.reports.get("restart").actions.some((action) => {
    return action.bossKey === "low" && action.status === "uncertain" && action.reason === "recorded-submission";
  }), true);
});

test("world boss dry run plans one assist for every boss but performs no mutations", async () => {
  const client = fakeClient("dry", { low: 3, high: 3 }, { rewardStatus: "claimable" });
  const result = await executeWorldBossSession({
    clients: [client],
    event: { id: "2026-08-18@16:00" },
    state: { version: 1, accounts: {} },
    saveState: async () => assert.fail("dry run must not save state"),
    dryRun: true
  });

  assert.deepEqual(client.posts, []);
  assert.deepEqual(result.reports.get("dry").actions.filter((action) => action.type === "world-boss-assist"), [{
    type: "world-boss-assist",
    status: "planned",
    bossKey: "low",
    instanceId: "low-instance",
    attempts: 1
  }, {
    type: "world-boss-assist",
    status: "planned",
    bossKey: "high",
    instanceId: "high-instance",
    attempts: 1
  }]);
});

test("world boss session leaves an account incomplete when active status lacks assist metadata", async () => {
  const client = fakeClient("missing-metadata", { low: 3 });
  client.api.get = async (path) => {
    if (path === "/api/boss/world-status") {
      return { data: [{
        bossKey: "low",
        instanceId: "low-instance",
        status: "active",
        remainingAttemptCount: 3,
        maxAttemptCount: 3
      }] };
    }
    if (path === "/api/client/dynamic-view") return { data: { bosses: [] } };
    throw new Error(`unexpected GET ${path}`);
  };
  const result = await executeWorldBossSession({
    clients: [client],
    event: { id: "2026-08-18@16:00" },
    state: { version: 1, accounts: {} },
    saveState: async () => {}
  });

  assert.equal(result.completed, false);
  assert.deepEqual(result.unresolvedAliases, ["missing-metadata"]);
  assert.equal(client.posts.length, 0);
});

function fakeClient(alias, initialCounts, options = {}) {
  const counts = { ...initialCounts };
  const posts = [];
  let ambiguousThrown = false;
  let rejectionThrown = false;
  const status = () => Object.entries(counts).map(([bossKey, remainingAttemptCount]) => ({
    bossKey,
    instanceId: `${bossKey}-instance`,
    status: "active",
    requiredLevel: bossKey === "low" ? 10 : 80,
    remainingAttemptCount,
    maxAttemptCount: 3,
    rewardStatus: options.rewardStatus ?? "pending"
  }));
  return {
    alias,
    counts,
    posts,
    api: {
      async get(path) {
        if (path === "/api/boss/world-status") return { data: status() };
        if (path === "/api/client/dynamic-view") {
          return { data: { bosses: Object.keys(counts).map((key) => ({ key, type: "world", assistBlockedReason: null })) } };
        }
        throw new Error(`unexpected GET ${path}`);
      },
      async post(path, body) {
        if (path === "/api/boss/claim-reward") {
          posts.push("claim");
          options.rewardStatus = "claimed";
          return { data: {} };
        }
        if (path !== "/api/boss/assist") throw new Error(`unexpected POST ${path}`);
        posts.push(body.bossKey);
        await options.onAssist?.(body.bossKey);
        if (body.bossKey === options.ambiguousBoss && !ambiguousThrown) {
          ambiguousThrown = true;
          throw new ApiError("network", { path, transport: true, ambiguous: true });
        }
        if (body.bossKey === options.rejectOnceBoss && !rejectionThrown) {
          rejectionThrown = true;
          throw new ApiError("rejected", { path, status: 409, detail: "try again", ambiguous: false });
        }
        counts[body.bossKey] -= 1;
        return { data: {} };
      }
    }
  };
}
