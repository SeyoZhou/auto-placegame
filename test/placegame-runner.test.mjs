import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { assertFreeArcadeResult, createProgressReporter, main, nextDailyAction } from "../placegame-auto.mjs";

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

  assert.deepEqual(lines.slice(4, 10).map(withoutDuration), [
    "[1/1] test: idle and map...",
    "[1/1] test: idle and map done (DURATION, 2 results)",
    "[1/1] test: free arcade...",
    "[1/1] test: free arcade done (DURATION, 4 results)",
    "[1/1] test: daily rewards...",
    "[1/1] test: daily rewards done (DURATION, 0 results)"
  ]);
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

test("mail without an attachment is not claimed", () => {
  const state = makeDailyState();
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
        player: { level: 1, gold: 0, idleRewardCapacityHours: 12 },
        daily: { key: "2026-08-12", claimedActivity: [] },
        retention: { signIn: { lastClaimedKey: "2026-08-12" } },
        mails: []
      };
    } else if (pathName === "/api/client/idle-summary") {
      data = { validSeconds: 0 };
    } else if (pathName === "/api/client/dynamic-view") {
      data = { maps: [], quests: [], achievements: [], codex: { rewards: [] }, rankingSeason: { rewards: [] }, navigation: {} };
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
