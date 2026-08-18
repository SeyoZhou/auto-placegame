import { ApiError, dataOf } from "./placegame-api.mjs";
import { mapWithConcurrency, serializeCalls } from "./placegame-async.mjs";
import { worldBossCandidates, worldBossRewardIsClaimable } from "./placegame-policy.mjs";

const ASSIST_LIMIT_PER_PAIR = 3;

export async function executeWorldBossSession({
  clients,
  event,
  state,
  saveState = async () => {},
  dryRun = false,
  concurrency = 3
}) {
  if (!event?.id) throw new Error("world boss event id is required");
  if (!Array.isArray(clients)) throw new Error("world boss clients must be an array");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) {
    throw new Error("world boss concurrency must be between 1 and 3");
  }

  const reports = new Map(clients.map((client) => [
    client.alias,
    client.report ?? { alias: client.alias, command: "world-boss", dryRun, actions: [] }
  ]));
  const eventState = worldBossEventState(state, event.id);
  const persist = serializeCalls(() => saveState(state));
  const snapshots = new Map();

  await mapWithConcurrency(clients, concurrency, async (client) => {
    try {
      snapshots.set(client.alias, await readWorldBossState(client.api));
    } catch (error) {
      reportFor(reports, client).actions.push(worldBossAction("world-boss-read", "failed", { reason: safeReason(error) }));
    }
  });

  await mapWithConcurrency(clients, concurrency, async (client) => {
    const snapshot = snapshots.get(client.alias);
    if (!snapshot || !snapshot.bosses.some(worldBossRewardIsClaimable)) return;
    const report = reportFor(reports, client);
    if (dryRun) {
      report.actions.push(worldBossAction("world-boss-reward", "planned"));
      return;
    }
    let error;
    try {
      await client.api.post("/api/boss/claim-reward");
    } catch (caught) {
      error = caught;
    }
    let refreshed;
    try {
      refreshed = await readWorldBossState(client.api);
      snapshots.set(client.alias, refreshed);
    } catch (refreshError) {
      report.actions.push(worldBossAction("world-boss-reward", error?.ambiguous ? "uncertain" : "failed", {
        reason: safeReason(refreshError)
      }));
      return;
    }
    if (!error) {
      report.actions.push(worldBossAction("world-boss-reward", "claimed"));
    } else if (error.ambiguous && !refreshed.bosses.some(worldBossRewardIsClaimable)) {
      report.actions.push(worldBossAction("world-boss-reward", "reconciled"));
    } else {
      report.actions.push(worldBossAction("world-boss-reward", error.ambiguous ? "uncertain" : "failed", {
        reason: safeReason(error)
      }));
    }
  });

  const priorities = prioritizedBosses(snapshots);
  for (const priority of priorities) {
    await mapWithConcurrency(clients, concurrency, async (client) => {
      const initial = findCandidate(snapshots.get(client.alias), priority);
      if (!initial) return;
      await drainBossPair({
        client,
        initial,
        eventState,
        report: reportFor(reports, client),
        persist,
        dryRun
      });
    });
  }

  const unresolvedAliases = [...reports]
    .filter(([, report]) => report.actions.some((action) => ["uncertain", "failed"].includes(action.status)))
    .map(([alias]) => alias);
  const unresolved = unresolvedAliases.length > 0;
  const completed = priorities.length > 0 && !unresolved;
  if (!dryRun) {
    eventState.status = completed ? "completed" : "incomplete";
    eventState.updatedAt = new Date().toISOString();
    if (completed) eventState.completedAt = eventState.updatedAt;
    await persist();
  }
  return { completed, reports, bossCount: priorities.length, unresolvedAliases };
}

export async function readWorldBossState(api) {
  const [statusPayload, viewPayload] = await Promise.all([
    api.get("/api/boss/world-status"),
    api.get("/api/client/dynamic-view")
  ]);
  const statuses = worldBossStatusEntries(dataOf(statusPayload));
  const view = dataOf(viewPayload);
  const metadata = new Map((Array.isArray(view?.bosses) ? view.bosses : [])
    .filter((boss) => boss?.type === "world" && typeof boss.key === "string")
    .map((boss) => [boss.key, boss]));
  return {
    bosses: statuses.map((status) => {
      const bossKey = status?.bossKey;
      const details = metadata.get(bossKey);
      if (status?.status === "active" && Number(status.remainingAttemptCount) > 0 && !details) {
        throw new Error(`world boss metadata is missing for ${bossKey ?? "unknown"}`);
      }
      return {
        ...status,
        bossKey,
        requiredLevel: details?.requiredLevel ?? status?.requiredLevel,
        assistBlockedReason: details ? details.assistBlockedReason : "missing-world-boss-metadata"
      };
    })
  };
}

function worldBossStatusEntries(value) {
  if (!Array.isArray(value)) throw new Error("world boss status response was malformed");
  return value;
}

function prioritizedBosses(snapshots) {
  const unique = new Map();
  for (const snapshot of snapshots.values()) {
    for (const boss of worldBossCandidates(snapshot.bosses)) {
      const identity = pairIdentity(boss);
      const current = unique.get(identity);
      if (!current || Number(boss.requiredLevel) < Number(current.requiredLevel)) unique.set(identity, boss);
    }
  }
  return worldBossCandidates([...unique.values()]);
}

async function drainBossPair({ client, initial, eventState, report, persist, dryRun }) {
  const account = eventState.accounts[client.alias] ??= { pairs: {} };
  account.pairs ??= {};
  const identity = pairIdentity(initial);
  const recorded = account.pairs[identity];
  if (recorded && ["completed", "uncertain"].includes(recorded.status)) {
    report.actions.push(worldBossAction("world-boss-assist", recorded.status === "uncertain" ? "uncertain" : "skipped", {
      bossKey: initial.bossKey,
      instanceId: initial.instanceId,
      reason: `recorded-${recorded.status}`
    }));
    return;
  }
  if (dryRun) {
    report.actions.push(worldBossAction("world-boss-assist", "planned", {
      bossKey: initial.bossKey,
      instanceId: initial.instanceId,
      attempts: Math.min(initial.remainingAttemptCount, initial.maxAttemptCount, ASSIST_LIMIT_PER_PAIR)
    }));
    return;
  }

  const pair = account.pairs[identity] = {
    status: "in-progress",
    bossKey: initial.bossKey,
    instanceId: initial.instanceId,
    attempts: recorded?.attempts ?? 0,
    updatedAt: new Date().toISOString()
  };
  await persist();

  while (pair.attempts < ASSIST_LIMIT_PER_PAIR) {
    let beforeState;
    try {
      beforeState = await readWorldBossState(client.api);
    } catch (error) {
      await stopPair(pair, "failed", error, report, persist);
      return;
    }
    const before = findCandidate(beforeState, initial);
    if (!before) {
      await completePair(pair, report, persist, initial, "unavailable");
      return;
    }

    let mutationError;
    try {
      await client.api.post("/api/boss/assist", { bossKey: before.bossKey });
    } catch (error) {
      mutationError = error;
    }

    let afterState;
    try {
      afterState = await readWorldBossState(client.api);
    } catch (error) {
      await stopPair(pair, mutationError?.ambiguous ? "uncertain" : "failed", error, report, persist);
      return;
    }
    const after = findBoss(afterState, before);
    const remainingDecreased = Number.isInteger(after?.remainingAttemptCount)
      && after.remainingAttemptCount < before.remainingAttemptCount;

    if (mutationError && !(mutationError.ambiguous && remainingDecreased)) {
      await stopPair(pair, mutationError.ambiguous ? "uncertain" : "failed", mutationError, report, persist);
      return;
    }
    if (!mutationError && after?.status === "active" && !remainingDecreased) {
      await stopPair(pair, "uncertain", new Error("refreshed remaining attempts did not decrease"), report, persist);
      return;
    }

    pair.attempts += 1;
    pair.updatedAt = new Date().toISOString();
    report.actions.push(worldBossAction("world-boss-assist", mutationError ? "reconciled" : "assisted", {
      bossKey: before.bossKey,
      instanceId: before.instanceId,
      remainingAttemptCount: after?.remainingAttemptCount
    }));
    if (!findCandidate(afterState, before)) {
      await completePair(pair, report, persist, before, "exhausted-or-unavailable", false);
      return;
    }
    if (pair.attempts >= ASSIST_LIMIT_PER_PAIR) {
      await completePair(pair, report, persist, before, "three-attempt-limit", false);
      return;
    }
    await persist();
  }
}

async function stopPair(pair, status, error, report, persist) {
  pair.status = status;
  pair.updatedAt = new Date().toISOString();
  pair.reason = safeReason(error);
  report.actions.push(worldBossAction("world-boss-assist", status, {
    bossKey: pair.bossKey,
    instanceId: pair.instanceId,
    reason: pair.reason
  }));
  await persist();
}

async function completePair(pair, report, persist, boss, reason, addReport = true) {
  pair.status = "completed";
  pair.updatedAt = new Date().toISOString();
  pair.completedAt = pair.updatedAt;
  pair.reason = reason;
  if (addReport) {
    report.actions.push(worldBossAction("world-boss-assist", "completed", {
      bossKey: boss.bossKey,
      instanceId: boss.instanceId,
      reason
    }));
  }
  await persist();
}

function findCandidate(snapshot, boss) {
  return worldBossCandidates(snapshot?.bosses).find((candidate) => pairIdentity(candidate) === pairIdentity(boss));
}

function findBoss(snapshot, boss) {
  return snapshot?.bosses.find((candidate) => pairIdentity(candidate) === pairIdentity(boss));
}

function pairIdentity(boss) {
  return `${boss.bossKey}:${boss.instanceId}`;
}

function worldBossEventState(state, eventId) {
  state.worldBoss ??= { events: {} };
  state.worldBoss.events ??= {};
  return state.worldBoss.events[eventId] ??= { status: "in-progress", accounts: {}, startedAt: new Date().toISOString() };
}

function reportFor(reports, client) {
  return reports.get(client.alias);
}

function worldBossAction(type, status, extra = {}) {
  return { type, status, ...extra };
}

function safeReason(error) {
  if (error instanceof ApiError) {
    if (error.ambiguous) return `${error.path ?? "request"}: outcome uncertain`;
    return `${error.path ?? "request"}: ${error.detail ?? "request rejected"}`;
  }
  return String(error?.message ?? "unknown error").replace(/\s+/g, " ").trim().slice(0, 240);
}
