import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  applyDefaults,
  assertFreeArcadeResult,
  createProgressReporter,
  main,
  nextDailyAction,
  runBestEquipment,
  runDaily,
  runPersonalBoss,
  validateConfig
} from "../placegame-auto.mjs";

test("progress reporter streams account stages with elapsed time", async () => {
  const lines = [];
  let now = 0;
  const progress = createProgressReporter({
    enabled: true,
    write: (line) => lines.push(line),
    now: () => now
  });

  progress.start({ command: "run", total: 2, dryRun: false });
  const account = progress.account({ alias: "account-1", current: 1, total: 2 });
  await account.stage("authentication", async () => {
    now = 1_250;
    return "authenticated";
  });
  await account.stage("idle and map", async () => {
    now = 2_000;
  }, () => "2 results");
  now = 2_500;
  account.finish({ ok: true });
  progress.finish({ succeeded: 1, failed: 1 });

  assert.deepEqual(lines, [
    "Starting run for 2 accounts.",
    "[1/2] account-1: starting",
    "[1/2] account-1: authentication...",
    "[1/2] account-1: authentication done (1.3s)",
    "[1/2] account-1: idle and map...",
    "[1/2] account-1: idle and map done (0.8s, 2 results)",
    "[1/2] account-1: completed (2.5s)",
    "Finished: 1 succeeded, 1 failed (2.5s)."
  ]);
});

test("disabled progress reporter stays silent", async () => {
  let clockReads = 0;
  const progress = createProgressReporter({
    enabled: false,
    write: () => assert.fail("disabled progress must not write output"),
    now: () => {
      clockReads += 1;
      return 0;
    }
  });

  progress.start({ command: "run", total: 1, dryRun: false });
  const account = progress.account({ alias: "account-1", current: 1, total: 1 });
  const result = await account.stage("authentication", async () => 42);
  account.finish({ ok: true });
  progress.finish({ succeeded: 1, failed: 0 });

  assert.equal(result, 42);
  assert.equal(clockReads, 0);
});

test("progress reporter redacts bearer values on stage failure", async () => {
  const lines = [];
  const progress = createProgressReporter({ write: (line) => lines.push(line) });
  const account = progress.account({ alias: "account-1", current: 1, total: 1 });

  await assert.rejects(
    account.stage("authentication", async () => { throw new Error("Bearer secret-session"); }),
    /secret-session/
  );
  assert.match(lines.at(-1), /Bearer \[redacted\]/);
  assert.doesNotMatch(lines.at(-1), /secret-session/);
});

test("progress output failure never interrupts account work", async () => {
  let writes = 0;
  let operations = 0;
  const progress = createProgressReporter({
    write: () => {
      writes += 1;
      if (writes === 2) throw new Error("output closed");
    }
  });

  progress.start({ command: "run", total: 1, dryRun: false });
  const account = progress.account({ alias: "account-1", current: 1, total: 1 });
  assert.equal(await account.stage("authentication", async () => {
    operations += 1;
    return 42;
  }), 42);
  account.finish({ ok: true });
  progress.finish({ succeeded: 1, failed: 0 });

  assert.equal(operations, 1);
  assert.equal(writes, 2);
});

test("main streams progress in human mode and keeps JSON output clean", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "placegame-progress-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = path.join(directory, "accounts.json");
  const statePath = path.join(directory, "state.json");
  const logDir = path.join(directory, "logs");
  await writeFile(configPath, '{"accounts":[{"name":"test","username":"u","password":"p"}]}\n');
  await chmod(configPath, 0o600);

  const humanLines = [];
  const baseArgs = ["status", "--config", configPath, "--state", statePath, "--log-dir", logDir];
  const dependencies = { fetchImpl: createStatusFetch(), outputWrite: (line) => humanLines.push(line) };
  assert.equal(await main(baseArgs, dependencies), 0);
  assert.match(humanLines[0], /^Starting status for 1 account\.$/);
  assert.match(humanLines[1], /^\[1\/1\] test: starting$/);
  assert.match(humanLines[2], /^\[1\/1\] test: authentication\.\.\.$/);
  assert.match(humanLines[3], /^\[1\/1\] test: authentication done \([\d.]+s\)$/);
  assert.match(humanLines[4], /^\[1\/1\] test: status\.\.\.$/);
  assert.match(humanLines[5], /^\[1\/1\] test: status done \([\d.]+s, 0 results\)$/);
  assert.match(humanLines[6], /^\[1\/1\] test: completed \([\d.]+s\)$/);
  assert.match(humanLines[7], /^Finished: 1 succeeded, 0 failed \([\d.]+s\)\.$/);
  assert.match(humanLines[8], /^\nSummary\ntest: ok/);

  const jsonLines = [];
  assert.equal(await main([...baseArgs, "--json"], {
    fetchImpl: createStatusFetch(),
    outputWrite: (line) => jsonLines.push(line)
  }), 0);
  assert.equal(jsonLines.length, 1);
  assert.equal(JSON.parse(jsonLines[0]).reports[0].alias, "test");
});

test("accounts on the same server reuse a negotiated client version", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "placegame-version-negotiation-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = path.join(directory, "accounts.json");
  await writeFile(configPath, JSON.stringify({ accounts: [
    { name: "first", username: "first-user", password: "first-password" },
    { name: "second", username: "second-user", password: "second-password" }
  ] }));
  await chmod(configPath, 0o600);
  const fallback = createStatusFetch();
  const loginVersions = [];
  const fetchImpl = async (url, options) => {
    if (new URL(url).pathname === "/api/auth/login") {
      const version = options.headers["x-placegame-client-version"];
      loginVersions.push(version);
      if (loginVersions.length === 1) {
        return {
          ok: false,
          status: 426,
          json: async () => ({ ok: false, error: "Upgrade to 0.2.38" })
        };
      }
    }
    return fallback(url, options);
  };

  assert.equal(await main([
    "status",
    "--config", configPath,
    "--state", path.join(directory, "state.json"),
    "--log-dir", path.join(directory, "logs")
  ], { fetchImpl, outputWrite: () => {} }), 0);

  assert.deepEqual(loginVersions, ["0.2.37", "0.2.38", "0.2.38"]);
});

test("run reports all phases in order", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "placegame-run-progress-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = path.join(directory, "accounts.json");
  await writeFile(configPath, '{"accounts":[{"name":"test","username":"u","password":"p"}]}\n');
  await chmod(configPath, 0o600);
  const lines = [];

  assert.equal(await main([
    "run",
    "--config", configPath,
    "--state", path.join(directory, "state.json"),
    "--log-dir", path.join(directory, "logs")
  ], { fetchImpl: createStatusFetch(), outputWrite: (line) => lines.push(line) }), 0);

  assert.deepEqual(lines.slice(4, 14).map(withoutDuration), [
    "[1/1] test: idle and map...",
    "[1/1] test: idle and map done (DURATION, 2 results)",
    "[1/1] test: free arcade...",
    "[1/1] test: free arcade done (DURATION, 4 results)",
    "[1/1] test: best equipment...",
    "[1/1] test: best equipment done (DURATION, 0 results)",
    "[1/1] test: personal boss...",
    "[1/1] test: personal boss done (DURATION, 1 result)",
    "[1/1] test: daily rewards...",
    "[1/1] test: daily rewards done (DURATION, 1 result)"
  ]);
  assert.match(lines.at(-1), /^\nSummary\ntest: ok/);
});

test("run continues daily rewards after the best-effort boss stage fails", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "placegame-boss-failure-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = path.join(directory, "accounts.json");
  await writeFile(configPath, '{"accounts":[{"name":"test","username":"u","password":"p"}]}\n');
  await chmod(configPath, 0o600);
  const lines = [];
  const fallback = createStatusFetch();
  const fetchImpl = async (url, options) => {
    if (new URL(url).pathname === "/api/equipment/list") throw new Error("equipment unavailable");
    return fallback(url, options);
  };

  assert.equal(await main([
    "run",
    "--config", configPath,
    "--state", path.join(directory, "state.json"),
    "--log-dir", path.join(directory, "logs")
  ], { fetchImpl, outputWrite: (line) => lines.push(line) }), 0);

  assert.match(lines.find((line) => line.includes("personal boss failed")), /equipment\/list: request rejected/);
  assert.equal(lines.some((line) => line.includes("daily rewards done")), true);
  assert.match(lines.at(-1), /^\nSummary\ntest: ok/);
});

test("one account failure reports progress and continues with the next account", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "placegame-failure-progress-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = path.join(directory, "accounts.json");
  await writeFile(configPath, JSON.stringify({ accounts: [
    { name: "first", username: "fail-user", password: "fail-password" },
    { name: "second", username: "ok-user", password: "ok-password" }
  ] }));
  await chmod(configPath, 0o600);
  const lines = [];

  const exitCode = await main([
    "status",
    "--config", configPath,
    "--state", path.join(directory, "state.json"),
    "--log-dir", path.join(directory, "logs")
  ], { fetchImpl: createAccountFailureFetch(), outputWrite: (line) => lines.push(line) });

  assert.equal(exitCode, 1);
  assert.match(lines[2], /^\[1\/2\] first: authentication\.\.\.$/);
  assert.match(lines[3], /^\[1\/2\] first: authentication failed \([\d.]+s\): \/api\/auth\/login: authentication rejected$/);
  assert.match(lines[4], /^\[1\/2\] first: failed \(\/api\/auth\/login: authentication rejected\) \([\d.]+s\)$/);
  assert.match(lines[5], /^\[2\/2\] second: starting$/);
  assert.match(lines.at(-2), /^Finished: 1 succeeded, 1 failed \([\d.]+s\)\.$/);
  assert.doesNotMatch(lines.join("\n"), /fail-user|fail-password|ok-user|ok-password/);
  assert.match(lines.at(-1), /^\nSummary\nfirst: error/);
  assert.match(lines.at(-1), /second: ok/);
});

test("version negotiation failure reports the server requirement", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "placegame-version-failure-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = path.join(directory, "accounts.json");
  await writeFile(configPath, '{"accounts":[{"name":"test","username":"u","password":"p"}]}\n');
  await chmod(configPath, 0o600);
  const lines = [];
  const fetchImpl = async () => ({
    ok: false,
    status: 426,
    json: async () => ({ ok: false, error: "Upgrade to 0.2.37" })
  });

  assert.equal(await main([
    "status",
    "--config", configPath,
    "--state", path.join(directory, "state.json"),
    "--log-dir", path.join(directory, "logs")
  ], { fetchImpl, outputWrite: (line) => lines.push(line) }), 1);

  assert.match(lines.join("\n"), /client upgrade failed \(server requires 0\.2\.37\)/);
});

test("daily claims require available completed quests", () => {
  const state = makeDailyState();
  state.view.quests = [
    { key: "blocked", available: false, completed: true, claimed: false },
    { key: "ready", available: true, completed: true, claimed: false }
  ];
  assert.deepEqual(nextDailyAction(state, [20]), {
    type: "quest-reward",
    path: "/api/quests/claim",
    body: { questKey: "ready" },
    identity: "ready"
  });
});

test("daily claims unlocked rewards in conservative order", () => {
  const state = makeDailyState();
  state.bootstrap.mails = [{ id: "mail-1", claimed: false, reward: { gold: 100 } }];
  state.view.navigation.activityClaimableCount = 1;
  state.view.achievements = [{ key: "achievement-1", unlocked: true, claimed: false }];
  state.view.codex.rewards = [{ key: "codex-1", unlocked: true, claimed: false }];
  state.view.rankingSeason.rewards = [{ key: "season-1", unlocked: true, claimed: false }];

  assert.equal(nextDailyAction(state, [20]).type, "achievement-reward");
  state.view.achievements[0].claimed = true;
  assert.equal(nextDailyAction(state, [20]).type, "codex-reward");
  state.view.codex.rewards[0].claimed = true;
  assert.equal(nextDailyAction(state, [20]).type, "season-reward");
  state.view.rankingSeason.rewards[0].claimed = true;
  assert.deepEqual(nextDailyAction(state, [20]), {
    type: "activity-reward",
    path: "/api/daily/claim",
    body: { point: 20 },
    point: 20
  });
  state.bootstrap.daily.claimedActivity.push(20);
  state.view.navigation.activityClaimableCount = 0;
  assert.equal(nextDailyAction(state, [20]).type, "mail-attachment");
});

test("daily claims may probe one known activity tier without a navigation badge", () => {
  const state = makeDailyState();
  state.bootstrap.daily.claimedActivity = [20, 40, 60, 80];

  assert.deepEqual(nextDailyAction(state, [20, 40, 60, 80, 100]), {
    type: "activity-reward",
    path: "/api/daily/claim",
    body: { point: 100 },
    point: 100
  });
});

test("mail without an attachment is not claimed", () => {
  const state = makeDailyState();
  state.bootstrap.daily.claimedActivity = [20];
  state.bootstrap.mails = [{ id: "notice", claimed: false, reward: {} }];
  assert.equal(nextDailyAction(state, [20]), undefined);
});

test("arcade guard accepts only explicitly free zero-cost outcomes", () => {
  assert.doesNotThrow(() => assertFreeArcadeResult({ free: true, costGold: 0 }, "slot"));
  assert.doesNotThrow(() => assertFreeArcadeResult({ round: { status: "active" } }, "treasure-reveal", { inheritedFree: true }));
  assert.throws(() => assertFreeArcadeResult({ free: false, costGold: 0 }, "slot"), /not confirmed as free/);
  assert.throws(() => assertFreeArcadeResult({ free: true, costGold: 100 }, "slot"), /not confirmed as free/);
  assert.throws(() => assertFreeArcadeResult({ rewardGold: 10 }, "slot"), /not confirmed as free/);
});

test("personal boss dry run previews the best candidate without challenging", async () => {
  const api = createBossApi({ freeRemaining: 5 });
  const context = bossContext(api, { dryRun: true });

  await runPersonalBoss(context);

  assert.equal(api.challengeCalls, 0);
  assert.equal(api.previewCalls, 1);
  assert.deepEqual(context.report.actions, [{
    type: "personal-boss",
    status: "planned",
    bossKey: "boss-1",
    difficulty: "nightmare",
    buffKey: "none",
    affixKey: "relentless",
    targetSlot: "weapon",
    chance: 88,
    rewardMultiplier: 1.18,
    costGold: 100,
    costMaterial: 2
  }]);
});

test("best equipment wears strict upgrades one slot at a time", async () => {
  const api = createEquipmentApi([
    dailyEquipment({ id: "weapon-current", status: "equipped", slot: "weapon", score: 10 }),
    dailyEquipment({ id: "weapon-best", slot: "weapon", score: 30 }),
    dailyEquipment({ id: "armor-current", status: "equipped", slot: "armor", score: 20 }),
    dailyEquipment({ id: "armor-best", slot: "armor", score: 25 }),
    dailyEquipment({ id: "armor-equal", slot: "armor", score: 20 })
  ]);
  const context = equipmentContext(api);

  const result = await runBestEquipment(context);

  assert.deepEqual(api.posts.map((entry) => entry.body), [
    { equipmentId: "armor-best" },
    { equipmentId: "weapon-best" }
  ]);
  assert.deepEqual(context.report.actions, [
    { type: "equipment-wear", status: "completed", slot: "armor", fromScore: 20, toScore: 25 },
    { type: "equipment-wear", status: "completed", slot: "weapon", fromScore: 10, toScore: 30 }
  ]);
  assert.equal(result.safeForDecomposition, true);
  assert.equal(result.equipment.find((item) => item.id === "weapon-best").status, "equipped");
});

test("best equipment continues later slots after an earlier authoritative failure", async () => {
  const api = createEquipmentApi([
    dailyEquipment({ id: "armor-current", status: "equipped", slot: "armor", score: 20 }),
    dailyEquipment({ id: "armor-best", slot: "armor", score: 25 }),
    dailyEquipment({ id: "weapon-current", status: "equipped", slot: "weapon", score: 10 }),
    dailyEquipment({ id: "weapon-best", slot: "weapon", score: 30 })
  ], {
    failedIds: new Set(["armor-best"])
  });
  const context = equipmentContext(api);

  const result = await runBestEquipment(context);

  assert.equal(api.posts.length, 2);
  assert.deepEqual(context.report.actions.map((entry) => [entry.slot, entry.status]), [
    ["armor", "failed"],
    ["weapon", "completed"]
  ]);
  assert.equal(result.safeForDecomposition, false);
  assert.equal(result.equipment.find((item) => item.id === "weapon-best").status, "equipped");
});

test("best equipment marks unchanged wear uncertain and continues", async () => {
  const api = createEquipmentApi([
    dailyEquipment({ id: "armor-current", status: "equipped", slot: "armor", score: 20 }),
    dailyEquipment({ id: "armor-best", slot: "armor", score: 25 }),
    dailyEquipment({ id: "weapon-current", status: "equipped", slot: "weapon", score: 10 }),
    dailyEquipment({ id: "weapon-best", slot: "weapon", score: 30 })
  ], { unchangedIds: new Set(["armor-best"]) });
  const context = equipmentContext(api);

  const result = await runBestEquipment(context);

  assert.deepEqual(context.report.actions.map((entry) => [entry.slot, entry.status]), [
    ["armor", "uncertain"],
    ["weapon", "completed"]
  ]);
  assert.equal(result.safeForDecomposition, false);
});

test("best equipment recomputes candidates from refreshed state", async () => {
  const api = createEquipmentApi([
    dailyEquipment({ id: "armor-current", status: "equipped", slot: "armor", score: 20 }),
    dailyEquipment({ id: "armor-best", slot: "armor", score: 25 }),
    dailyEquipment({ id: "weapon-current", status: "equipped", slot: "weapon", score: 10 }),
    dailyEquipment({ id: "weapon-best", slot: "weapon", score: 30 })
  ], {
    afterWear(equipment, equipmentId) {
      if (equipmentId === "armor-best") {
        equipment.push(dailyEquipment({ id: "weapon-new-best", slot: "weapon", score: 40 }));
      }
    }
  });
  const context = equipmentContext(api);

  const result = await runBestEquipment(context);

  assert.deepEqual(api.posts.map((entry) => entry.body), [
    { equipmentId: "armor-best" },
    { equipmentId: "weapon-new-best" }
  ]);
  assert.equal(result.safeForDecomposition, true);
});

test("best equipment dry run plans upgrades without wearing them", async () => {
  const api = createEquipmentApi([
    dailyEquipment({ id: "weapon-current", status: "equipped", slot: "weapon", score: 10 }),
    dailyEquipment({ id: "weapon-best", slot: "weapon", score: 30 })
  ]);
  const context = equipmentContext(api, { dryRun: true });

  const result = await runBestEquipment(context);

  assert.equal(api.posts.length, 0);
  assert.deepEqual(context.report.actions, [{
    type: "equipment-wear",
    status: "planned",
    slot: "weapon",
    fromScore: 10,
    toScore: 30
  }]);
  assert.equal(result.safeForDecomposition, true);
  assert.equal(result.equipment.find((item) => item.id === "weapon-best").status, "equipped");
});

test("best equipment rejects a malformed equipment response", async () => {
  const context = equipmentContext({
    async get(pathName) {
      assert.equal(pathName, "/api/equipment/list");
      return { data: {} };
    }
  });

  const result = await runBestEquipment(context);

  assert.deepEqual(result, {
    safeForDecomposition: false,
    equipment: undefined,
    reason: "equipment-state-read-failed"
  });
  assert.deepEqual(context.report.actions, [{
    type: "equipment-wear",
    status: "failed",
    reason: "equipment list response was malformed"
  }]);
});

test("best equipment marks an unknown equipped score unsafe", async () => {
  const api = createEquipmentApi([
    dailyEquipment({ id: "current", status: "equipped", slot: "weapon", score: undefined }),
    dailyEquipment({ id: "candidate", slot: "weapon", score: 30 })
  ]);
  const context = equipmentContext(api);

  const result = await runBestEquipment(context);

  assert.equal(api.posts.length, 0);
  assert.equal(result.safeForDecomposition, false);
  assert.equal(result.reason, "equipped-score-unknown");
  assert.deepEqual(context.report.actions, [{
    type: "equipment-wear",
    status: "stopped",
    slot: "weapon",
    reason: "equipped-score-unknown"
  }]);
});

test("best equipment marks an unknown candidate score unsafe", async () => {
  const api = createEquipmentApi([
    dailyEquipment({ id: "current", status: "equipped", slot: "weapon", score: 10 }),
    dailyEquipment({ id: "candidate", slot: "weapon", score: null })
  ]);
  const context = equipmentContext(api);

  const result = await runBestEquipment(context);

  assert.equal(api.posts.length, 0);
  assert.equal(result.safeForDecomposition, false);
  assert.equal(result.reason, "candidate-score-unknown");
});

test("personal boss submits the exact previewed challenge body", async () => {
  const api = createBossApi({ freeRemaining: 1, consumeFree: true });
  const context = bossContext(api);

  await runPersonalBoss(context);

  assert.deepEqual(api.challengeBodies, [{
    bossKey: "boss-1",
    difficulty: "nightmare",
    selectedSkillKeys: ["skill-1"],
    affixKey: "relentless",
    targetSlot: "weapon",
    useMaterialBoost: false,
    buffKey: "none"
  }]);
});

test("personal boss retries returned failures and stops after twenty submissions", async () => {
  const api = createBossApi({ freeRemaining: 5, challengeResult: { battle: { win: false } } });
  const context = bossContext(api);

  await runPersonalBoss(context);

  assert.equal(api.challengeCalls, 20);
  assert.equal(context.report.actions.filter((action) => action.status === "lost-free-returned").length, 20);
  assert.deepEqual(context.report.actions.at(-1), {
    type: "personal-boss",
    status: "stopped",
    reason: "submission-limit",
    submissions: 20
  });
});

test("personal boss reconciles an ambiguous win and stops when free pool is empty", async () => {
  const api = createBossApi({ freeRemaining: 1, ambiguousChallenge: true, consumeFree: true });
  const context = bossContext(api);

  await runPersonalBoss(context);

  assert.equal(api.challengeCalls, 1);
  assert.equal(context.report.actions[0].status, "reconciled-win");
  assert.equal(context.report.actions.at(-1).status, "no-free-attempt");
});

test("personal boss does not resubmit an unresolved ambiguous challenge", async () => {
  const api = createBossApi({ freeRemaining: 5, ambiguousChallenge: true, recordBossAttempt: false });
  const context = bossContext(api);

  await runPersonalBoss(context);

  assert.equal(api.challengeCalls, 1);
  assert.equal(context.report.actions[0].status, "uncertain");
  assert.equal(context.report.actions.at(-1).reason, "challenge-outcome-unknown");
});

test("personal boss stops when a returned loss conflicts with refreshed counters", async () => {
  const api = createBossApi({
    freeRemaining: 5,
    challengeResult: { battle: { win: false } },
    recordBossAttempt: false
  });
  const context = bossContext(api);

  await runPersonalBoss(context);

  assert.equal(api.challengeCalls, 1);
  assert.equal(context.report.actions[0].status, "uncertain");
  assert.equal(context.report.actions.at(-1).reason, "challenge-outcome-unknown");
});

test("daily rewards isolate a failed identity and continue other families", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80, 100],
    achievements: [
      { key: "broken", unlocked: true, claimed: false },
      { key: "ready", unlocked: true, claimed: false }
    ],
    guild: {
      joined: true,
      progressRewards: [{ point: 60, canClaim: true, claimed: false }]
    },
    failPaths: new Set(["/api/achievements/claim:broken"])
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.deepEqual(api.posts.map((entry) => entry.key), [
    "/api/achievements/claim:broken",
    "/api/achievements/claim:ready",
    "/api/guild/claim-progress:60"
  ]);
  assert.equal(context.report.actions.find((entry) => entry.identity === "broken").status, "failed");
  assert.equal(context.report.actions.find((entry) => entry.identity === "ready").status, "claimed");
  assert.equal(context.report.actions.find((entry) => entry.type === "guild-progress-reward").status, "claimed");
  assert.equal(context.report.activity.status, "already-complete");
});

test("daily rewards reconcile an ambiguous claim and report non-membership", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80, 100],
    achievements: [{ key: "ready", unlocked: true, claimed: false }],
    ambiguousPaths: new Set(["/api/achievements/claim"])
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.equal(context.report.actions.find((entry) => entry.identity === "ready").status, "reconciled");
  assert.deepEqual(context.report.actions.find((entry) => entry.type === "guild-progress-reward"), {
    type: "guild-progress-reward",
    status: "unavailable",
    reason: "not-member"
  });
});

test("daily rewards continue when guild state cannot be read", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80, 100],
    achievements: [{ key: "ready", unlocked: true, claimed: false }],
    failGuildRead: true
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.equal(api.posts.find((entry) => entry.key === "/api/achievements/claim:ready")?.path, "/api/achievements/claim");
  assert.deepEqual(context.report.actions.find((entry) => entry.type === "guild-progress-reward"), {
    type: "guild-progress-reward",
    status: "unavailable",
    reason: "state-read-failed"
  });
});

test("daily rewards treat an omitted refreshed collection as uncertain", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80, 100],
    achievements: [{ key: "ready", unlocked: true, claimed: false }],
    omitAfterClaim: new Set(["achievements"])
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.equal(context.report.actions.find((entry) => entry.identity === "ready").status, "uncertain");
});

test("daily rewards reject malformed endpoint identities", () => {
  const state = makeDailyState();
  state.bootstrap.daily.claimedActivity = [20];
  state.view.quests = [{ key: "", available: true, completed: true, claimed: false }];
  state.view.achievements = [{ unlocked: true, claimed: false }];
  state.view.codex.rewards = [{ key: 1, unlocked: true, claimed: false }];
  state.view.rankingSeason.rewards = [{ key: " ", unlocked: true, claimed: false }];
  state.guild = { joined: true, progressRewards: [{ point: "60", canClaim: true, claimed: false }] };
  state.bootstrap.mails = [{ id: "", claimed: false, reward: { gold: 1 } }];

  assert.equal(nextDailyAction(state, [20]), undefined);
});

test("daily activity claims a known tier with a stale zero badge before spending assets", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80],
    claimableActivity: [100],
    activityClaimableCount: 0,
    equipment: [dailyEquipment({ id: "safe" })]
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.deepEqual(api.posts.map((entry) => entry.path), ["/api/daily/claim"]);
  assert.equal(context.report.activity.status, "newly-complete");
});

test("daily activity performs no asset mutation when 100 is already claimed", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80, 100],
    equipment: [dailyEquipment({ id: "safe" })],
    orders: [{ id: "cheap", orderType: "sell", itemType: "equipment", status: "active", currencyType: "gold", price: 1, amount: 1 }]
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.equal(api.posts.some((entry) => entry.path.startsWith("/api/equipment/") || entry.path === "/api/market/buy"), false);
  assert.equal(context.report.activity.status, "already-complete");
});

test("legacy activity tier subsets do not enable the 100-point asset ladder", async () => {
  const api = createDailyApi({
    claimedActivity: [20],
    equipment: [dailyEquipment({ id: "safe" })],
    orders: [{ id: "cheap", orderType: "sell", itemType: "equipment", status: "active", currencyType: "gold", price: 1, amount: 1 }]
  });
  const context = dailyContext(api);
  context.config.automation.daily.activityRewardPoints = [20];

  await runDaily(context);

  assert.equal(api.posts.some((entry) => entry.path.startsWith("/api/equipment/") || entry.path === "/api/market/buy"), false);
  assert.equal(context.report.activity.reason, "target-not-configured");
});

test("daily activity stops asset mutations when claimed activity state is unknown", async () => {
  const api = createDailyApi({
    claimedActivity: null,
    equipment: [dailyEquipment({ id: "safe" })],
    orders: [{ id: "cheap", orderType: "sell", itemType: "equipment", status: "active", currencyType: "gold", price: 1, amount: 1 }]
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.equal(api.posts.some((entry) => entry.path.startsWith("/api/equipment/") || entry.path === "/api/market/buy"), false);
  assert.equal(context.report.activity.reason, "unknown-activity-state");
});

test("daily activity continues the ladder after an authoritative target claim rejection", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80],
    activityClaimableCount: 1,
    equipment: [dailyEquipment({ id: "safe" })],
    orders: [{ id: "cheap", orderType: "sell", itemType: "equipment", status: "active", currencyType: "gold", price: 1, amount: 1 }],
    failPaths: new Set(["/api/daily/claim:100"])
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.equal(api.posts.some((entry) => entry.path === "/api/equipment/decompose"), true);
  assert.equal(context.report.actions.find((entry) => entry.type === "activity-reward").status, "failed");
});

test("daily activity decomposes one safe item then claims 100 and stops", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80],
    equipment: [dailyEquipment({ id: "first" }), dailyEquipment({ id: "second", score: 20 })],
    unlockActivityAfter: "decompose"
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.equal(api.posts.filter((entry) => entry.path === "/api/equipment/decompose").length, 1);
  assert.deepEqual(api.posts.find((entry) => entry.path === "/api/equipment/decompose").body, { equipmentIds: ["first"] });
  assert.deepEqual(api.posts.find((entry) => entry.path === "/api/daily/claim").body, { point: 100 });
  assert.equal(context.report.activity.status, "newly-complete");
  assert.equal(api.equipment.some((item) => item.id === "second"), true);
});

test("daily wears upgrades before considering replaced equipment for decomposition", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80],
    equipment: [
      dailyEquipment({ id: "old", status: "equipped", slot: "weapon", score: 10 }),
      dailyEquipment({ id: "upgrade", slot: "weapon", score: 20 })
    ],
    unlockActivityAfter: "decompose"
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.deepEqual(api.posts.map((entry) => entry.path), [
    "/api/daily/claim",
    "/api/equipment/wear",
    "/api/equipment/decompose-preview",
    "/api/equipment/decompose",
    "/api/daily/claim"
  ]);
  assert.deepEqual(api.posts[1].body, { equipmentId: "upgrade" });
  assert.deepEqual(api.posts[3].body, { equipmentIds: ["old"] });
});

test("daily blocks decomposition and purchase after a wear failure", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80],
    equipment: [
      dailyEquipment({ id: "current", status: "equipped", slot: "weapon", score: 10 }),
      dailyEquipment({ id: "upgrade", slot: "weapon", score: 20 }),
      dailyEquipment({ id: "safe", slot: "armor", score: 5 })
    ],
    orders: [{ id: "cheap", orderType: "sell", itemType: "equipment", status: "active", currencyType: "gold", price: 1, amount: 1 }],
    failPaths: new Set(["/api/equipment/wear:"])
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.equal(api.posts.some((entry) => entry.path === "/api/equipment/decompose"), false);
  assert.equal(api.posts.some((entry) => entry.path === "/api/market/buy"), false);
  assert.deepEqual(context.report.actions.find((entry) => entry.type === "equipment-decompose"), {
    type: "equipment-decompose",
    status: "stopped",
    reason: "equipment-wear-failed"
  });
});

test("daily wears a reward-dropped upgrade before later decomposition", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60],
    equipment: [
      dailyEquipment({ id: "current", status: "equipped", slot: "weapon", score: 10 }),
      dailyEquipment({ id: "first-safe", score: 1 }),
      dailyEquipment({ id: "second-safe", score: 2 })
    ],
    decomposeUnlockPoints: [80, 100],
    rewardEquipmentByActivity: {
      80: dailyEquipment({ id: "reward-upgrade", slot: "weapon", score: 30 })
    }
  });
  const context = dailyContext(api);

  await runDaily(context);

  const decompositionIndexes = api.posts
    .map((entry, index) => entry.path === "/api/equipment/decompose" ? index : -1)
    .filter((index) => index >= 0);
  const wearIndex = api.posts.findIndex((entry) => entry.path === "/api/equipment/wear");
  assert.equal(decompositionIndexes.length, 2);
  assert.ok(decompositionIndexes[0] < wearIndex && wearIndex < decompositionIndexes[1]);
  assert.deepEqual(api.posts[wearIndex].body, { equipmentId: "reward-upgrade" });
  assert.notDeepEqual(api.posts[decompositionIndexes[1]].body, { equipmentIds: ["reward-upgrade"] });
  assert.equal(api.equipment.find((item) => item.id === "reward-upgrade").status, "equipped");
});

test("daily activity buys at most one cheapest unit after decomposition is exhausted", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80],
    orders: [
      { id: "cost-250", orderType: "sell", itemType: "equipment", status: "active", currencyType: "gold", price: 250, amount: 1 },
      { id: "cost-120", orderType: "sell", itemType: "material", status: "active", currencyType: "gold", price: 600, amount: 5 }
    ],
    unlockActivityAfter: "market"
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.deepEqual(api.posts.filter((entry) => entry.path === "/api/market/buy").map((entry) => entry.body), [
    { orderId: "cost-120", quantity: 1 }
  ]);
  assert.equal(context.report.activity.status, "newly-complete");
});

test("daily activity reconciles an ambiguous decomposition from counter and inventory", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80],
    equipment: [dailyEquipment({ id: "safe" })],
    unlockActivityAfter: "decompose",
    ambiguousPaths: new Set(["/api/equipment/decompose"])
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.equal(context.report.actions.find((entry) => entry.type === "equipment-decompose").status, "reconciled");
  assert.equal(context.report.activity.status, "newly-complete");
});

test("daily activity stops after an unresolved ambiguous purchase", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80],
    orders: [
      { id: "first", orderType: "sell", itemType: "equipment", status: "active", currencyType: "gold", price: 100, amount: 1 },
      { id: "second", orderType: "sell", itemType: "equipment", status: "active", currencyType: "gold", price: 200, amount: 1 }
    ],
    ambiguousPaths: new Set(["/api/market/buy"]),
    ambiguousWithoutMutation: new Set(["/api/market/buy"])
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.equal(api.posts.filter((entry) => entry.path === "/api/market/buy").length, 1);
  assert.equal(context.report.actions.find((entry) => entry.type === "market-buy").status, "uncertain");
  assert.equal(context.report.activity.status, "incomplete");
});

test("daily activity reconciles one ambiguous purchase from the daily counter", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80],
    orders: [{ id: "cheap", orderType: "sell", itemType: "equipment", status: "active", currencyType: "gold", price: 100, amount: 1 }],
    unlockActivityAfter: "market",
    ambiguousPaths: new Set(["/api/market/buy"])
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.equal(api.posts.filter((entry) => entry.path === "/api/market/buy").length, 1);
  assert.equal(context.report.actions.find((entry) => entry.type === "market-buy").status, "reconciled");
  assert.equal(context.report.activity.status, "newly-complete");
});

test("daily activity stops assets after an unresolved ambiguous target claim", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80],
    claimableActivity: [100],
    equipment: [dailyEquipment({ id: "safe" })],
    ambiguousPaths: new Set(["/api/daily/claim"]),
    ambiguousWithoutMutation: new Set(["/api/daily/claim"])
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.equal(api.posts.some((entry) => entry.path.startsWith("/api/equipment/") || entry.path === "/api/market/buy"), false);
  assert.equal(context.report.actions.find((entry) => entry.type === "activity-reward").status, "failed");
  assert.equal(context.report.actions.find((entry) => entry.type === "activity-target" && entry.status === "stopped").reason, "reward-claim-blocked");
});

test("daily activity bounds repeated decomposition preview failures", async () => {
  const equipment = Array.from({ length: 70 }, (_, index) => dailyEquipment({ id: `eq-${index}`, score: index }));
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80],
    equipment,
    failDecomposePreviews: true
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.equal(api.posts.filter((entry) => entry.path === "/api/equipment/decompose-preview").length, 3);
  assert.equal(api.posts.some((entry) => entry.path === "/api/equipment/decompose" || entry.path === "/api/market/buy"), false);
  assert.equal(context.report.actions.find((entry) => entry.reason === "preview-failure-limit").status, "stopped");
});

test("daily activity skips purchase when the daily market count is already used", async () => {
  const api = createDailyApi({ claimedActivity: [20, 40, 60, 80], marketBuyCount: 1 });
  const context = dailyContext(api);

  await runDaily(context);

  assert.equal(api.posts.some((entry) => entry.path === "/api/market/buy"), false);
  assert.equal(context.report.actions.find((entry) => entry.type === "market-buy").reason, "daily-purchase-used");
  assert.deepEqual(context.report.activity, {
    status: "incomplete",
    claimed: [20, 40, 60, 80],
    remaining: [100],
    failedRewards: 1
  });
});

test("daily dry run plans safe decomposition without preview, decomposition, or purchase mutations", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80],
    equipment: [dailyEquipment({ id: "safe" })],
    orders: [{ id: "cheap", orderType: "sell", itemType: "equipment", status: "active", currencyType: "gold", price: 1, amount: 1 }]
  });
  const context = dailyContext(api, { dryRun: true });

  await runDaily(context);

  assert.equal(api.posts.length, 0);
  assert.deepEqual(context.report.actions.find((entry) => entry.status === "protected"), undefined);
  assert.equal(context.report.actions.find((entry) => entry.type === "equipment-decompose").status, "planned");
  assert.deepEqual(context.report.actions.find((entry) => entry.type === "market-buy"), {
    type: "market-buy",
    status: "planned",
    quantity: 1,
    projectedGold: 1,
    reason: "if-activity-target-remains"
  });
  assert.equal(context.report.activity.status, "incomplete");
});

test("daily dry run reports protected equipment before the market fallback", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80],
    equipment: [dailyEquipment({ id: "premium", rareRank: "极品" })],
    orders: [{ id: "cheap", orderType: "sell", itemType: "equipment", status: "active", currencyType: "gold", price: 10, amount: 1 }]
  });
  const context = dailyContext(api, { dryRun: true });

  await runDaily(context);

  assert.equal(api.posts.length, 0);
  assert.deepEqual(context.report.actions.find((entry) => entry.status === "protected"), {
    type: "equipment-decompose",
    status: "protected",
    reason: "premium-or-unknown-affix",
    count: 1
  });
  assert.equal(context.report.actions.find((entry) => entry.type === "market-buy").projectedGold, 10);
});

test("daily configuration defaults and validates safety controls", () => {
  const config = applyDefaults({ accounts: [{ name: "test", username: "u", password: "p" }] });
  assert.deepEqual(config.automation.daily, {
    activityRewardPoints: [20, 40, 60, 80, 100],
    marketMaxGold: 300,
    decomposition: {
      qualities: ["white", "green", "blue"],
      minLevel: undefined,
      maxLevel: undefined,
      protectPremiumAffixes: true
    }
  });
  assert.doesNotThrow(() => validateConfig(config));

  const allQualities = applyDefaults({
    accounts: [{ name: "test", username: "u", password: "p" }],
    automation: { daily: { decomposition: {
      qualities: ["common", "excellent", "refined", "rare", "epic", "legendary", "mythic"]
    } } }
  });
  assert.deepEqual(allQualities.automation.daily.decomposition.qualities, [
    "white", "green", "blue", "purple", "orange", "red", "gold"
  ]);
  assert.doesNotThrow(() => validateConfig(allQualities));

  const legacyTierSubset = applyDefaults({
    accounts: [{ name: "test", username: "u", password: "p" }],
    automation: { daily: { activityRewardPoints: [20] } }
  });
  assert.doesNotThrow(() => validateConfig(legacyTierSubset));

  const invalid = structuredClone(config);
  invalid.automation.daily.decomposition.minLevel = 20;
  invalid.automation.daily.decomposition.maxLevel = 10;
  assert.throws(() => validateConfig(invalid), /minLevel/);

  const invalidTier = structuredClone(config);
  invalidTier.automation.daily.activityRewardPoints = [20, 999, 100];
  assert.throws(() => validateConfig(invalidTier), /known tiers/);

  const invalidQuality = structuredClone(config);
  invalidQuality.automation.daily.decomposition.qualities = ["cyan"];
  assert.throws(() => validateConfig(invalidQuality), /unknown quality/);
});

test("runner rejects a world-readable credential file before networking", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "placegame-permission-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = path.join(directory, "accounts.json");
  await writeFile(configPath, '{"accounts":[{"name":"test","username":"u","password":"p"}]}\n');
  await chmod(configPath, 0o644);
  const result = spawnSync(process.execPath, [path.resolve("placegame-auto.mjs"), "status", "--config", configPath], {
    cwd: path.resolve("."),
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must have mode 0600/);
});

function makeDailyState() {
  return {
    bootstrap: {
      daily: { key: "2026-08-12", claimedActivity: [] },
      retention: { signIn: { lastClaimedKey: "2026-08-12" } },
      mails: [],
      claimedMailRewardIds: []
    },
    view: {
      navigation: { activityClaimableCount: 0 },
      quests: [],
      achievements: [],
      codex: { rewards: [] },
      rankingSeason: { rewards: [] }
    }
  };
}

function createStatusFetch() {
  return async (url, options) => {
    const pathName = new URL(url).pathname;
    let data;
    if (pathName === "/api/auth/login") {
      data = { sessionToken: "test-session", expiresAt: "2099-01-01T00:00:00Z" };
    } else if (pathName === "/api/client/bootstrap") {
      data = {
        player: { level: 1, gold: 0, idleRewardCapacityHours: 12, personalBossAttempts: { freeRemaining: 0 } },
        daily: { key: "2026-08-12", marketBuyCount: 0, claimedActivity: [20, 40, 60, 80, 100] },
        retention: { signIn: { lastClaimedKey: "2026-08-12" } },
        mails: []
      };
    } else if (pathName === "/api/client/idle-summary") {
      data = { validSeconds: 0 };
    } else if (pathName === "/api/client/dynamic-view") {
      data = { maps: [], bosses: [], quests: [], achievements: [], codex: { rewards: [] }, rankingSeason: { rewards: [] }, navigation: {} };
    } else if (pathName === "/api/equipment/list") {
      data = [];
    } else if (pathName === "/api/guild/view") {
      data = { joined: false, progressRewards: [] };
    } else if (pathName === "/api/arcade/view") {
      data = {};
    } else if (pathName === "/api/arcade/coin-pusher/view") {
      data = { guild: { rewards: [] } };
    } else {
      assert.fail(`unexpected request: ${options.method} ${pathName}`);
    }
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
}

function bossContext(api, options = {}) {
  return {
    api,
    options: { dryRun: false, ...options },
    report: { actions: [] }
  };
}

function equipmentContext(api, options = {}) {
  return {
    api,
    options: { dryRun: false, ...options },
    report: { actions: [] }
  };
}

function createEquipmentApi(equipment, {
  ambiguousIds = new Set(),
  failedIds = new Set(),
  unchangedIds = new Set(),
  afterWear
} = {}) {
  return {
    equipment: structuredClone(equipment),
    posts: [],
    async get(pathName) {
      if (pathName === "/api/equipment/list") return { data: structuredClone(this.equipment) };
      assert.fail(`unexpected GET ${pathName}`);
    },
    async post(pathName, body) {
      assert.equal(pathName, "/api/equipment/wear");
      this.posts.push({ path: pathName, body: structuredClone(body) });
      if (failedIds.has(body.equipmentId)) throw new Error("wear rejected");
      if (!unchangedIds.has(body.equipmentId)) wearEquipment(this.equipment, body.equipmentId);
      afterWear?.(this.equipment, body.equipmentId);
      if (ambiguousIds.has(body.equipmentId)) {
        throw Object.assign(new Error("lost response"), { ambiguous: true });
      }
      return { data: {} };
    }
  };
}

function createBossApi({ freeRemaining, challengeResult, ambiguousChallenge = false, consumeFree = false, recordBossAttempt = true }) {
  let remaining = freeRemaining;
  let bossCount = 0;
  return {
    previewCalls: 0,
    challengeCalls: 0,
    challengeBodies: [],
    async get(pathName) {
      if (pathName === "/api/client/bootstrap") return { data: {
        daily: { bossCount },
        player: { personalBossAttempts: { freeRemaining: remaining } }
      } };
      if (pathName === "/api/client/dynamic-view") return { data: {
        bosses: [bossFixture(remaining)]
      } };
      if (pathName === "/api/equipment/list") return { data: [
        { id: "eq-1", status: "equipped", slot: "weapon", score: 10 }
      ] };
      assert.fail(`unexpected GET ${pathName}`);
    },
    async post(pathName, body) {
      if (pathName === "/api/boss/preview") {
        this.previewCalls += 1;
        return { data: { chance: 88, predictedWin: true } };
      }
      if (pathName === "/api/boss/challenge") {
        this.challengeCalls += 1;
        this.challengeBodies.push(structuredClone(body));
        if (recordBossAttempt) bossCount += 1;
        if (consumeFree) remaining -= 1;
        if (ambiguousChallenge) throw Object.assign(new Error("lost response"), { ambiguous: true });
        return { data: challengeResult ?? { battle: { win: true } } };
      }
      assert.fail(`unexpected POST ${pathName}`);
    }
  };
}

function bossFixture(freeRemaining) {
  return {
    key: "boss-1",
    type: "personal",
    requiredLevel: 1,
    blockedReason: "",
    personalAttemptPool: { freeRemaining },
    difficultyOptions: [{
      key: "nightmare",
      blockedReason: "",
      goldCost: 100,
      ticketCost: 0,
      materialCost: 2,
      ownedGold: 1000,
      ownedMaterial: 10
    }],
    challengeOptions: {
      skills: [{ key: "skill-1" }],
      buffs: [{ key: "none" }],
      affixes: [{ key: "relentless", rewardMultiplier: 1.18 }],
      targetSlots: ["weapon"]
    }
  };
}

function dailyContext(api, options = {}) {
  return {
    api,
    options: { dryRun: false, ...options },
    config: applyDefaults({ accounts: [{ name: "test", username: "u", password: "p" }] }),
    report: { actions: [] }
  };
}

function createDailyApi({
  claimedActivity = [],
  achievements = [],
  guild = { joined: false, progressRewards: [] },
  equipment = [],
  orders = [],
  marketBuyCount = 0,
  activityClaimableCount = 0,
  claimableActivity = [],
  failPaths = new Set(),
  unlockActivityAfter,
  ambiguousPaths = new Set(),
  ambiguousWithoutMutation = new Set(),
  failGuildRead = false,
  omitAfterClaim = new Set(),
  failDecomposePreviews = false,
  decomposeUnlockPoints,
  rewardEquipmentByActivity = {}
} = {}) {
  const claimablePoints = new Set(claimableActivity);
  const pendingDecomposeUnlocks = Array.isArray(decomposeUnlockPoints)
    ? [...decomposeUnlockPoints]
    : unlockActivityAfter === "decompose" ? [100] : [];
  const state = {
    bootstrap: {
      player: { gold: 10_000 },
      daily: {
        key: "2026-08-13",
        ...(Array.isArray(claimedActivity) ? { claimedActivity: [...claimedActivity] } : {}),
        decomposeCount: 0,
        marketBuyCount
      },
      retention: { signIn: { lastClaimedKey: "2026-08-13" } },
      mails: [],
      claimedMailRewardIds: []
    },
    view: {
      navigation: { activityClaimableCount },
      quests: [],
      achievements: structuredClone(achievements),
      codex: { rewards: [] },
      rankingSeason: { rewards: [] }
    },
    guild: structuredClone(guild)
  };
  return {
    state,
    equipment: structuredClone(equipment),
    orders: structuredClone(orders),
    posts: [],
    async get(pathName) {
      if (pathName === "/api/client/bootstrap") return { data: structuredClone(state.bootstrap) };
      if (pathName === "/api/client/dynamic-view") {
        const view = structuredClone(state.view);
        if (omitAfterClaim.has("achievements") && this.posts.some((entry) => entry.path === "/api/achievements/claim")) delete view.achievements;
        return { data: view };
      }
      if (pathName === "/api/guild/view") {
        if (failGuildRead) throw new Error("guild unavailable");
        return { data: structuredClone(state.guild) };
      }
      if (pathName === "/api/equipment/list") return { data: structuredClone(this.equipment) };
      if (pathName === "/api/market/orders") return { data: structuredClone(this.orders) };
      assert.fail(`unexpected GET ${pathName}`);
    },
    async post(pathName, body) {
      const key = `${pathName}:${body.achievementKey ?? body.point ?? body.orderId ?? ""}`;
      this.posts.push({ path: pathName, body: structuredClone(body), key });
      if (failPaths.has(key)) throw new Error("request rejected");
      const skipMutation = ambiguousWithoutMutation.has(pathName);
      if (pathName === "/api/achievements/claim") {
        state.view.achievements.find((entry) => entry.key === body.achievementKey).claimed = true;
      } else if (pathName === "/api/guild/claim-progress") {
        state.guild.progressRewards.find((entry) => entry.point === body.point).claimed = true;
      } else if (pathName === "/api/equipment/wear") {
        wearEquipment(this.equipment, body.equipmentId);
      } else if (pathName === "/api/equipment/decompose-preview") {
        if (failDecomposePreviews) throw new Error("preview unavailable");
        return { data: { equipmentIds: [...body.equipmentIds], equipmentCount: body.equipmentIds.length, goldGain: 1, materials: [] } };
      } else if (pathName === "/api/equipment/decompose") {
        if (!skipMutation) {
          state.bootstrap.daily.decomposeCount += 1;
          this.equipment = this.equipment.filter((entry) => !body.equipmentIds.includes(entry.id));
          const unlockedPoint = pendingDecomposeUnlocks.shift();
          if (unlockedPoint !== undefined) {
            state.view.navigation.activityClaimableCount = 1;
            claimablePoints.add(unlockedPoint);
          }
        }
      } else if (pathName === "/api/market/buy") {
        if (!skipMutation) {
          state.bootstrap.daily.marketBuyCount += 1;
          if (unlockActivityAfter === "market") {
            state.view.navigation.activityClaimableCount = 1;
            claimablePoints.add(100);
          }
        }
      } else if (pathName === "/api/daily/claim") {
        if (!claimablePoints.has(body.point) && state.view.navigation.activityClaimableCount <= 0) {
          throw new Error("activity reward is not claimable");
        }
        if (!skipMutation) {
          state.bootstrap.daily.claimedActivity.push(body.point);
          claimablePoints.delete(body.point);
          state.view.navigation.activityClaimableCount = Math.max(0, state.view.navigation.activityClaimableCount - 1);
          const rewardEquipment = rewardEquipmentByActivity[body.point];
          if (rewardEquipment) this.equipment.push(structuredClone(rewardEquipment));
        }
      } else {
        assert.fail(`unexpected POST ${pathName}`);
      }
      if (ambiguousPaths.has(pathName)) throw Object.assign(new Error("lost response"), { ambiguous: true });
      return { data: {} };
    }
  };
}

function dailyEquipment(overrides = {}) {
  return {
    id: "eq-1",
    status: "in_bag",
    locked: false,
    quality: "white",
    level: 1,
    score: 10,
    rareRank: "普通装备",
    ...overrides
  };
}

function wearEquipment(equipment, equipmentId) {
  const candidate = equipment.find((entry) => entry.id === equipmentId);
  for (const entry of equipment) {
    if (entry.slot !== candidate.slot) continue;
    entry.status = entry.id === candidate.id ? "equipped" : "in_bag";
    entry.equipped = entry.id === candidate.id;
  }
}

function createAccountFailureFetch() {
  const success = createStatusFetch();
  return async (url, options) => {
    if (new URL(url).pathname === "/api/auth/login" && JSON.parse(options.body).username === "fail-user") {
      return { ok: false, status: 401, json: async () => ({ ok: false }) };
    }
    return success(url, options);
  };
}

function withoutDuration(line) {
  return line.replace(/[\d.]+s/, "DURATION");
}
