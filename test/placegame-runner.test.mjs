import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { assertFreeArcadeResult, nextDailyAction } from "../placegame-auto.mjs";

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
