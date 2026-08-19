import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../lib/placegame-api.mjs";
import { executeWorldBossSession } from "../lib/placegame-world-boss.mjs";

test("world boss session submits one lower-boss assist per account with at most three accounts in flight", async () => {
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
  assert.equal(order.length, 4);
  assert.equal(order.every((entry) => entry.startsWith("low:")), true);
  assert.equal(result.completed, true);
  for (const client of clients) {
    assert.equal(client.counts.low, 2);
    assert.equal(client.counts.high, 3);
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
  assert.equal(uncertain.counts.high, 1);
  assert.equal(healthy.counts.low, 1);
  assert.equal(healthy.counts.high, 1);
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

test("world boss session persists the one-submission account limit", async () => {
  const client = fakeClient("single", { low: 3, high: 3 });
  const state = { version: 1, accounts: {} };
  const event = { id: "2026-08-18@16:00" };

  await executeWorldBossSession({ clients: [client], event, state, saveState: async () => {} });
  await executeWorldBossSession({ clients: [client], event, state, saveState: async () => {} });

  assert.deepEqual(client.posts, ["low"]);
  assert.equal(state.worldBoss.events[event.id].accounts.single.assistSubmitted, true);
});

test("world boss dry run reads plans but performs no mutations", async () => {
  const client = fakeClient("dry", { low: 3 }, { rewardStatus: "claimable" });
  const result = await executeWorldBossSession({
    clients: [client],
    event: { id: "2026-08-18@16:00" },
    state: { version: 1, accounts: {} },
    saveState: async () => assert.fail("dry run must not save state"),
    dryRun: true
  });

  assert.deepEqual(client.posts, []);
  assert.equal(result.reports.get("dry").actions.filter((action) => action.status === "planned").length, 2);
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
        counts[body.bossKey] -= 1;
        return { data: {} };
      }
    }
  };
}
