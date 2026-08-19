import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ApiError } from "../lib/placegame-api.mjs";
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

test("progress reporter distinguishes network failures and includes server rejection details", async () => {
  const lines = [];
  const progress = createProgressReporter({ write: (line) => lines.push(line) });
  const account = progress.account({ alias: "account-1", current: 1, total: 1 });

  await assert.rejects(account.stage("read", async () => {
    throw new ApiError("network request did not complete", {
      path: "/api/read",
      code: "TypeError",
      transport: true
    });
  }));
  await assert.rejects(account.stage("preview", async () => {
    throw new ApiError("server rejected POST /api/boss/preview", {
      path: "/api/boss/preview",
      status: 400,
      detail: "最多选择 3 个出战技能。"
    });
  }));

  assert.match(lines.find((line) => line.includes("read failed")), /\/api\/read: network request failed/);
  assert.match(lines.find((line) => line.includes("preview failed")), /\/api\/boss\/preview: request rejected \(最多选择 3 个出战技能。\)/);
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

test("world boss command skips outside Beijing activity windows without networking", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "placegame-world-boss-window-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = path.join(directory, "accounts.json");
  await writeFile(configPath, '{"accounts":[{"name":"test","username":"u","password":"p"}]}\n');
  await chmod(configPath, 0o600);
  const output = [];

  assert.equal(await main([
    "world-boss",
    "--config", configPath,
    "--state", path.join(directory, "state.json"),
    "--log-dir", path.join(directory, "logs"),
    "--json"
  ], {
    currentDate: () => new Date("2026-08-18T07:30:00.000Z"),
    fetchImpl: async () => assert.fail("outside-window command must not use the network"),
    outputWrite: (line) => output.push(line)
  }), 0);

  const result = JSON.parse(output[0]);
  assert.equal(result.timeContext.beijingTime, "2026-08-18T15:30:00");
  assert.match(result.timeContext.hostUtcOffset, /^[+-]\d{2}:\d{2}$/);
  assert.deepEqual(result.reports[0].actions, [
    { type: "world-boss", status: "skipped", reason: "outside-activity-window" }
  ]);
});

test("world boss dry run plans the current event without assist or reward mutations", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "placegame-world-boss-dry-run-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = path.join(directory, "accounts.json");
  await writeFile(configPath, '{"accounts":[{"name":"test","username":"u","password":"p"}]}\n');
  await chmod(configPath, 0o600);
  const requests = [];
  const output = [];
  const fetchImpl = async (url, options) => {
    const pathName = new URL(url).pathname;
    requests.push({ path: pathName, method: options.method });
    let data;
    if (pathName === "/api/auth/login") data = { sessionToken: "session" };
    else if (pathName === "/api/client/bootstrap") data = {};
    else if (pathName === "/api/boss/world-status") data = [{
      bossKey: "low",
      instanceId: "instance",
      status: "active",
      remainingAttemptCount: 3,
      maxAttemptCount: 3,
      requiredLevel: 10,
      rewardStatus: "pending"
    }];
    else if (pathName === "/api/client/dynamic-view") data = {
      bosses: [{ key: "low", type: "world", requiredLevel: 10, assistBlockedReason: null }]
    };
    else assert.fail(`unexpected request: ${options.method} ${pathName}`);
    return { ok: true, status: 200, json: async () => ({ data }) };
  };

  assert.equal(await main([
    "world-boss",
    "--dry-run",
    "--config", configPath,
    "--state", path.join(directory, "state.json"),
    "--log-dir", path.join(directory, "logs"),
    "--json"
  ], {
    currentDate: () => new Date("2026-08-18T08:00:00.000Z"),
    fetchImpl,
    outputWrite: (line) => output.push(line)
  }), 0);

  assert.equal(requests.some((request) => request.path === "/api/boss/assist"), false);
  assert.equal(requests.some((request) => request.path === "/api/boss/claim-reward"), false);
  const action = JSON.parse(output[0]).reports[0].actions.find((entry) => entry.type === "world-boss-assist");
  assert.deepEqual(action, {
    type: "world-boss-assist",
    status: "planned",
    bossKey: "low",
    instanceId: "instance",
    attempts: 1
  });
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

test("idle resolves a percentage adventure before switching to the better map", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "placegame-idle-adventure-map-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const configPath = path.join(directory, "accounts.json");
  await writeFile(configPath, '{"accounts":[{"name":"test","username":"u","password":"p"}]}\n');
  await chmod(configPath, 0o600);
  const { fetchImpl, posts } = createIdleAdventureFetch();
  const output = [];

  assert.equal(await main([
    "idle",
    "--json",
    "--config", configPath,
    "--state", path.join(directory, "state.json"),
    "--log-dir", path.join(directory, "logs")
  ], { fetchImpl, outputWrite: (line) => output.push(line) }), 0);

  assert.deepEqual(posts, [
    { path: "/api/battle/idle-collect", body: { adventureOptionKey: "clean" } },
    { path: "/api/battle/change-map", body: { mapKey: "better" } }
  ]);
  assert.deepEqual(JSON.parse(output[0]).reports[0].actions.map((action) => [action.type, action.status]), [
    ["adventure", "selected"],
    ["idle-collect", "not-due"],
    ["map", "changed"]
  ]);
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

  assert.match(lines.find((line) => line.includes("personal boss failed")), /equipment\/list: network request failed/);
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

test("personal boss challenges at the 10 percent predicted win boundary", async () => {
  const api = createBossApi({
    freeRemaining: 1,
    consumeFree: true,
    previewResult: { chance: 10, predictedWin: true }
  });
  const context = bossContext(api);

  await runPersonalBoss(context);

  assert.equal(api.challengeCalls, 1);
  assert.equal(context.report.actions[0].chance, 10);
  assert.equal(context.report.actions[0].status, "won");
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

test("best equipment never submits an item above the player level", async () => {
  const api = createEquipmentApi([
    dailyEquipment({ id: "current", status: "equipped", slot: "talisman", level: 33, score: 1734 }),
    dailyEquipment({ id: "too-high", slot: "talisman", level: 111, score: 2000 }),
    dailyEquipment({ id: "wearable", slot: "talisman", level: 74, score: 1800 })
  ]);
  const context = equipmentContext(api);

  await runBestEquipment(context, 74);

  assert.deepEqual(api.posts.map((entry) => entry.body), [{ equipmentId: "wearable" }]);
  assert.equal(api.gets.includes("/api/client/bootstrap"), false);
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
      if (pathName === "/api/client/bootstrap") return { data: { player: { level: 100 } } };
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

test("best equipment preserves an unknown-score candidate without blocking decomposition", async () => {
  const api = createEquipmentApi([
    dailyEquipment({ id: "current", status: "equipped", slot: "weapon", score: 10 }),
    dailyEquipment({ id: "candidate", slot: "weapon", score: null })
  ]);
  const context = equipmentContext(api);

  const result = await runBestEquipment(context);

  assert.equal(api.posts.length, 0);
  assert.equal(result.safeForDecomposition, true);
  assert.equal(result.reason, undefined);
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
    useMaterialBoost: true,
    buffKey: "none"
  }]);
});

test("personal boss wears a won upgrade before choosing the next target slot", async () => {
  const api = createBossApi({
    freeRemaining: 2,
    consumeFree: true,
    targetSlots: ["weapon", "armor"],
    equipment: [
      { id: "weapon-current", status: "equipped", slot: "weapon", level: 1, score: 10 },
      { id: "armor-current", status: "equipped", slot: "armor", level: 1, score: 20 }
    ],
    rewardEquipmentByChallenge: {
      1: { id: "weapon-upgrade", status: "in_bag", slot: "weapon", level: 1, score: 30 }
    }
  });
  const context = bossContext(api);

  await runPersonalBoss(context);

  assert.deepEqual(api.challengeBodies.map((body) => body.targetSlot), ["weapon", "armor"]);
  assert.deepEqual(api.wearBodies, [{ equipmentId: "weapon-upgrade" }]);
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

test("daily activity claims a known tier with a stale zero badge before cleaning equipment", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80],
    claimableActivity: [100],
    activityClaimableCount: 0,
    equipment: [dailyEquipment({ id: "safe" })]
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.deepEqual(api.posts.map((entry) => entry.path), [
    "/api/daily/claim",
    "/api/equipment/decompose-preview",
    "/api/equipment/decompose"
  ]);
  assert.equal(context.report.activity.status, "newly-complete");
});

test("daily activity does not probe higher tiers after the next tier is rejected", async () => {
  const api = createDailyApi({ claimedActivity: [] });
  const context = dailyContext(api);

  await runDaily(context);

  assert.deepEqual(
    api.posts.filter((entry) => entry.path === "/api/daily/claim").map((entry) => entry.body.point),
    [20]
  );
  assert.deepEqual(
    context.report.actions.filter((entry) => entry.type === "activity-reward").map((entry) => [entry.point, entry.status]),
    [[20, "failed"]]
  );
});

test("daily decomposes every safe item when 100 is already claimed without buying", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80, 100],
    equipment: [dailyEquipment({ id: "first" }), dailyEquipment({ id: "second", score: 20 })],
    orders: [{ id: "cheap", orderType: "sell", itemType: "equipment", status: "active", currencyType: "gold", price: 1, amount: 1 }]
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.deepEqual(api.posts.filter((entry) => entry.path === "/api/equipment/decompose").map((entry) => entry.body), [
    { equipmentIds: ["first", "second"] }
  ]);
  assert.equal(api.posts.some((entry) => entry.path === "/api/market/buy"), false);
  assert.equal(api.equipment.length, 0);
  assert.equal(context.report.activity.status, "already-complete");
});

test("daily decomposition defaults include common through epic and enforce score and level ceilings", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80, 100],
    equipment: [
      dailyEquipment({ id: "common", quality: "white", score: 1 }),
      dailyEquipment({ id: "premium", quality: "white", score: 2, rareRank: "极品" }),
      dailyEquipment({ id: "unknown-rank", quality: "white", score: 3, rareRank: undefined }),
      dailyEquipment({ id: "excellent", quality: "green", score: 4 }),
      dailyEquipment({ id: "refined", quality: "blue", score: 5 }),
      dailyEquipment({ id: "rare", quality: "purple", score: 6 }),
      dailyEquipment({ id: "epic", quality: "orange", score: 7 }),
      dailyEquipment({ id: "legendary", quality: "red", score: 8 }),
      dailyEquipment({ id: "over-level", quality: "white", score: 9, level: 1_000 }),
      dailyEquipment({ id: "at-score-limit", quality: "white", score: 99_999 }),
      dailyEquipment({ id: "empty-score", quality: "white", score: "", slot: "ring" }),
      dailyEquipment({ id: "whitespace-score", quality: "white", score: "   ", slot: "amulet" })
    ]
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.deepEqual(api.posts.filter((entry) => entry.path === "/api/equipment/decompose").map((entry) => entry.body), [
    { equipmentIds: ["common", "premium", "unknown-rank", "excellent", "refined", "rare", "epic"] }
  ]);
  assert.deepEqual(api.equipment.map((item) => item.id), [
    "legendary", "over-level", "at-score-limit", "empty-score", "whitespace-score"
  ]);
});

test("legacy activity tier subsets clean equipment without enabling the market fallback", async () => {
  const api = createDailyApi({
    claimedActivity: [20],
    equipment: [dailyEquipment({ id: "safe" })],
    orders: [{ id: "cheap", orderType: "sell", itemType: "equipment", status: "active", currencyType: "gold", price: 1, amount: 1 }]
  });
  const context = dailyContext(api);
  context.config.automation.daily.activityRewardPoints = [20];

  await runDaily(context);

  assert.equal(api.posts.some((entry) => entry.path === "/api/equipment/decompose"), true);
  assert.equal(api.posts.some((entry) => entry.path === "/api/market/buy"), false);
  assert.equal(context.report.activity.reason, "target-not-configured");
});

test("daily cleans equipment but skips the market when claimed activity state is unknown", async () => {
  const api = createDailyApi({
    claimedActivity: null,
    equipment: [dailyEquipment({ id: "safe" })],
    orders: [{ id: "cheap", orderType: "sell", itemType: "equipment", status: "active", currencyType: "gold", price: 1, amount: 1 }]
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.equal(api.posts.some((entry) => entry.path === "/api/equipment/decompose"), true);
  assert.equal(api.posts.some((entry) => entry.path === "/api/market/buy"), false);
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

test("daily activity decomposes every safe item when the batch unlocks 100", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80],
    equipment: [dailyEquipment({ id: "first" }), dailyEquipment({ id: "second", score: 20 })],
    unlockActivityAfter: "decompose"
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.deepEqual(api.posts.filter((entry) => entry.path === "/api/equipment/decompose").map((entry) => entry.body), [
    { equipmentIds: ["first", "second"] }
  ]);
  assert.deepEqual(api.posts.find((entry) => entry.path === "/api/daily/claim").body, { point: 100 });
  assert.equal(context.report.activity.status, "newly-complete");
  assert.equal(api.equipment.length, 0);
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
  assert.deepEqual(api.posts[decompositionIndexes[0]].body, { equipmentIds: ["first-safe", "second-safe"] });
  assert.deepEqual(api.posts[wearIndex].body, { equipmentId: "reward-upgrade" });
  assert.notDeepEqual(api.posts[decompositionIndexes[1]].body, { equipmentIds: ["reward-upgrade"] });
  assert.equal(api.equipment.find((item) => item.id === "reward-upgrade").status, "equipped");
  assert.equal(api.equipment.some((item) => item.id === "current"), false);
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

test("daily cleans equipment but skips the market after an unresolved target claim", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80],
    claimableActivity: [100],
    equipment: [dailyEquipment({ id: "safe" })],
    ambiguousPaths: new Set(["/api/daily/claim"]),
    ambiguousWithoutMutation: new Set(["/api/daily/claim"])
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.equal(api.posts.some((entry) => entry.path === "/api/equipment/decompose"), true);
  assert.equal(api.posts.some((entry) => entry.path === "/api/market/buy"), false);
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

test("daily decomposition rejects a batch when preview omits a candidate", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80, 100],
    equipment: [dailyEquipment({ id: "first" }), dailyEquipment({ id: "second" })],
    decomposePreviewIds: ["first"]
  });
  const context = dailyContext(api);

  await runDaily(context);

  assert.equal(api.posts.some((entry) => entry.path === "/api/equipment/decompose"), false);
  assert.equal(api.equipment.length, 2);
  assert.deepEqual(context.report.actions.find((entry) => entry.type === "equipment-decompose"), {
    type: "equipment-decompose",
    status: "skipped",
    count: 2,
    reason: "preview-unconfirmed"
  });
});

test("daily decomposition batches large inventory cleanup without truncation", async () => {
  const equipment = Array.from({ length: 70 }, (_, index) => dailyEquipment({ id: `eq-${index}`, score: index }));
  const api = createDailyApi({ claimedActivity: [20, 40, 60, 80, 100], equipment });
  const context = dailyContext(api);

  await runDaily(context);

  assert.deepEqual(api.posts.filter((entry) => entry.path === "/api/equipment/decompose").map((entry) => entry.body.equipmentIds.length), [50, 20]);
  assert.equal(api.posts.filter((entry) => entry.path === "/api/equipment/decompose-preview").length, 2);
  assert.equal(api.equipment.length, 0);
  assert.equal(context.report.activity.status, "already-complete");
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

test("daily dry run reports protected equipment when affix protection is enabled", async () => {
  const api = createDailyApi({
    claimedActivity: [20, 40, 60, 80],
    equipment: [dailyEquipment({ id: "premium", rareRank: "极品" })],
    orders: [{ id: "cheap", orderType: "sell", itemType: "equipment", status: "active", currencyType: "gold", price: 10, amount: 1 }]
  });
  const context = dailyContext(api, { dryRun: true });
  context.config.automation.daily.decomposition.protectPremiumAffixes = true;

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
      qualities: ["white", "green", "blue", "purple", "orange"],
      minLevel: undefined,
      maxLevel: 999,
      maxScore: 99_999,
      protectPremiumAffixes: false
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

  const invalidMaxScore = structuredClone(config);
  invalidMaxScore.automation.daily.decomposition.maxScore = 0;
  assert.throws(() => validateConfig(invalidMaxScore), /maxScore/);

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
  afterWear,
  playerLevel = 100
} = {}) {
  return {
    equipment: structuredClone(equipment),
    gets: [],
    posts: [],
    async get(pathName) {
      this.gets.push(pathName);
      if (pathName === "/api/client/bootstrap") return { data: { player: { level: playerLevel } } };
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

function createBossApi({
  freeRemaining,
  challengeResult,
  previewResult = { chance: 88, predictedWin: true },
  ambiguousChallenge = false,
  consumeFree = false,
  recordBossAttempt = true,
  targetSlots = ["weapon"],
  equipment = [{ id: "eq-1", status: "equipped", slot: "weapon", level: 1, score: 10 }],
  rewardEquipmentByChallenge = {}
}) {
  let remaining = freeRemaining;
  let bossCount = 0;
  return {
    equipment: structuredClone(equipment),
    previewCalls: 0,
    challengeCalls: 0,
    challengeBodies: [],
    wearBodies: [],
    async get(pathName) {
      if (pathName === "/api/client/bootstrap") return { data: {
        daily: { bossCount },
        player: { level: 100, personalBossAttempts: { freeRemaining: remaining } }
      } };
      if (pathName === "/api/client/dynamic-view") return { data: {
        bosses: [bossFixture(remaining, targetSlots)]
      } };
      if (pathName === "/api/equipment/list") return { data: structuredClone(this.equipment) };
      assert.fail(`unexpected GET ${pathName}`);
    },
    async post(pathName, body) {
      if (pathName === "/api/boss/preview") {
        this.previewCalls += 1;
        return { data: previewResult };
      }
      if (pathName === "/api/boss/challenge") {
        this.challengeCalls += 1;
        this.challengeBodies.push(structuredClone(body));
        if (recordBossAttempt) bossCount += 1;
        if (consumeFree) remaining -= 1;
        if (rewardEquipmentByChallenge[this.challengeCalls]) {
          this.equipment.push(structuredClone(rewardEquipmentByChallenge[this.challengeCalls]));
        }
        if (ambiguousChallenge) throw Object.assign(new Error("lost response"), { ambiguous: true });
        return { data: challengeResult ?? { battle: { win: true } } };
      }
      if (pathName === "/api/equipment/wear") {
        this.wearBodies.push(structuredClone(body));
        wearEquipment(this.equipment, body.equipmentId);
        return { data: {} };
      }
      assert.fail(`unexpected POST ${pathName}`);
    }
  };
}

function bossFixture(freeRemaining, targetSlots = ["weapon"]) {
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
      targetSlots
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
  decomposePreviewIds,
  decomposeUnlockPoints,
  rewardEquipmentByActivity = {}
} = {}) {
  const claimablePoints = new Set(claimableActivity);
  const pendingDecomposeUnlocks = Array.isArray(decomposeUnlockPoints)
    ? [...decomposeUnlockPoints]
    : unlockActivityAfter === "decompose" ? [100] : [];
  const state = {
    bootstrap: {
      player: { gold: 10_000, level: 100 },
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
        const previewIds = decomposePreviewIds ?? body.equipmentIds;
        return { data: { equipmentIds: [...previewIds], equipmentCount: previewIds.length, goldGain: 1, materials: [] } };
      } else if (pathName === "/api/equipment/decompose") {
        if (!skipMutation) {
          state.bootstrap.daily.decomposeCount += body.equipmentIds.length;
          this.equipment = this.equipment.filter((entry) => !body.equipmentIds.includes(entry.id));
          for (const _equipmentId of body.equipmentIds) {
            const unlockedPoint = pendingDecomposeUnlocks.shift();
            if (unlockedPoint !== undefined) {
              state.view.navigation.activityClaimableCount += 1;
              claimablePoints.add(unlockedPoint);
            }
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

function createIdleAdventureFetch() {
  const posts = [];
  const bootstrap = {
    player: { level: 72, idleRewardCapacityHours: 12 },
    daily: { key: "2026-08-17", claimedActivity: [] },
    idleAdventure: {
      key: "quiet_shrine",
      options: [
        { key: "clean", effectText: "经验收益 +8%" },
        { key: "take_coin", effectText: "金币收益 +15%，经验收益 -5%" },
        { key: "leave", effectText: "本次收益不变" }
      ]
    }
  };
  const maps = [
    { key: "current", current: true, unlocked: true, baseExpPerMin: 100, baseGoldPerMin: 50, efficiency: 1 },
    { key: "better", current: false, unlocked: true, baseExpPerMin: 120, baseGoldPerMin: 60, efficiency: 1 }
  ];
  const fetchImpl = async (url, options) => {
    const pathName = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    if (pathName === "/api/auth/login") {
      return { ok: true, status: 200, json: async () => ({ data: { sessionToken: "session" } }) };
    }
    if (pathName === "/api/client/bootstrap") {
      return { ok: true, status: 200, json: async () => ({ data: structuredClone(bootstrap) }) };
    }
    if (pathName === "/api/client/idle-summary") {
      return { ok: true, status: 200, json: async () => ({ data: { validSeconds: 0 } }) };
    }
    if (pathName === "/api/client/dynamic-view") {
      return { ok: true, status: 200, json: async () => ({ data: { maps: structuredClone(maps) } }) };
    }
    if (pathName === "/api/battle/idle-collect") {
      posts.push({ path: pathName, body });
      delete bootstrap.idleAdventure;
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    }
    if (pathName === "/api/battle/change-map") {
      posts.push({ path: pathName, body });
      for (const map of maps) map.current = map.key === body.mapKey;
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    }
    assert.fail(`unexpected request: ${options.method} ${pathName}`);
  };
  return { fetchImpl, posts };
}

function withoutDuration(line) {
  return line.replace(/[\d.]+s/, "DURATION");
}
