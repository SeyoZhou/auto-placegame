import test from "node:test";
import assert from "node:assert/strict";
import {
  blackjackDecision,
  blackjackValue,
  chooseAdventure,
  chooseBestMap,
  chooseCoinLane,
  isIdleDue,
  shouldChangeMap,
  stableJitterSeconds
} from "../lib/placegame-policy.mjs";

test("map selection maximizes effective experience then effective gold", () => {
  const maps = [
    { key: "current", current: true, unlocked: true, baseExpPerMin: 50, baseGoldPerMin: 20, efficiency: 1 },
    { key: "gold-tie-break", unlocked: true, baseExpPerMin: 25, baseGoldPerMin: 50, efficiency: 2 },
    { key: "locked", unlocked: false, baseExpPerMin: 999, baseGoldPerMin: 999, efficiency: 1 }
  ];
  assert.equal(chooseBestMap(maps).key, "gold-tie-break");
  assert.deepEqual(shouldChangeMap(maps), { current: maps[0], best: maps[1], change: true });
});

test("map selection keeps current map when it is already best", () => {
  const maps = [
    { key: "current", current: true, unlocked: true, baseExpPerMin: 50, baseGoldPerMin: 20, efficiency: 1 },
    { key: "worse", unlocked: true, baseExpPerMin: 100, baseGoldPerMin: 100, efficiency: 0.4 }
  ];
  assert.equal(shouldChangeMap(maps).change, false);
});

test("map selection does not switch between equal-rate maps", () => {
  const maps = [
    { key: "z-current", current: true, unlocked: true, baseExpPerMin: 50, baseGoldPerMin: 20, efficiency: 1 },
    { key: "a-equal", unlocked: true, baseExpPerMin: 25, baseGoldPerMin: 10, efficiency: 2 }
  ];
  assert.equal(chooseBestMap(maps).key, "a-equal");
  assert.equal(shouldChangeMap(maps).change, false);
});

test("adventure selects experience before gold and understands compact values", () => {
  const options = [
    { key: "gold", effectText: "金币 +3万" },
    { key: "exp-small", effectText: "经验 +1200" },
    { key: "exp-large", description: "获得 2千 经验" }
  ];
  const result = chooseAdventure(options);
  assert.equal(result.reason, "experience");
  assert.equal(result.choice.key, "exp-large");
});

test("adventure remains pending when any option is incomparable", () => {
  const result = chooseAdventure([
    { key: "exp", effectText: "经验 +1000" },
    { key: "mystery", effectText: "命运将作出选择" }
  ]);
  assert.equal(result.choice, undefined);
  assert.equal(result.reason, "unknown-option");
});

test("stable jitter is deterministic and bounded", () => {
  const first = stableJitterSeconds("account-1", 12);
  assert.equal(first, stableJitterSeconds("account-1", 12));
  assert.ok(first >= -720 && first <= 720);
});

test("idle due uses regular threshold and urgent cap threshold", () => {
  assert.equal(isIdleDue({ validSeconds: 6 * 3600 - 1, intervalHours: 6, capacityHours: 12 }), false);
  assert.equal(isIdleDue({ validSeconds: 6 * 3600, intervalHours: 6, capacityHours: 12 }), true);
  assert.equal(isIdleDue({ validSeconds: 11.6 * 3600, intervalHours: 20, capacityHours: 12, urgentLeadMinutes: 30 }), true);
});

test("blackjack uses basic hit and stand decisions without split or double", () => {
  assert.deepEqual(blackjackValue([{ rank: "A" }, { rank: "7" }]), { total: 18, soft: true });
  assert.equal(blackjackDecision({ hands: [{ cards: [{ rank: "10" }, { rank: "6" }] }], dealerCards: [{ rank: "10" }] }), "hit");
  assert.equal(blackjackDecision({ hands: [{ cards: [{ rank: "10" }, { rank: "7" }] }], dealerCards: [{ rank: "A" }] }), "stand");
});

test("coin lane values configured gold and shared points", () => {
  const lane = chooseCoinLane([["gold"], ["world"], ["crown"]], {
    gold: { rewardGold: 60, globalPoints: 1, guildPoints: 1 },
    world: { rewardGold: 120, globalPoints: 12, guildPoints: 8 },
    crown: { rewardGold: 260, globalPoints: 4, guildPoints: 4 }
  });
  assert.equal(lane.laneIndex, 1);
});
