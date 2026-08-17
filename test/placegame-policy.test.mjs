import test from "node:test";
import assert from "node:assert/strict";
import {
  blackjackDecision,
  blackjackValue,
  chooseAdventure,
  chooseBestMap,
  chooseBossPreview,
  chooseBestEquipmentUpgrade,
  chooseCoinLane,
  chooseLowestChargeMarketOrder,
  chooseSafeDecomposition,
  countProtectedDecomposition,
  equipmentComparisonIssue,
  isIdleDue,
  lowestScoredEquippedSlot,
  personalBossPreviewLayers,
  safeDecompositionCandidates,
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

test("adventure compares percentage yields and treats unchanged yield as neutral", () => {
  const result = chooseAdventure([
    { key: "clean", effectText: "经验收益 +8%" },
    { key: "take_coin", effectText: "金币收益 +15%，经验收益 -5%" },
    { key: "leave", effectText: "本次收益不变" }
  ]);

  assert.equal(result.reason, "experience");
  assert.equal(result.choice.key, "clean");
  assert.deepEqual(result.parsed.map(({ exp, gold }) => ({ exp, gold })), [
    { exp: 8, gold: undefined },
    { exp: -5, gold: 15 },
    { exp: 0, gold: 0 }
  ]);
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

test("personal boss layers prioritize progression, difficulty, and reward multiplier", () => {
  const bosses = [
    personalBoss({ key: "lower", requiredLevel: 10 }),
    personalBoss({ key: "higher", requiredLevel: 20 })
  ];
  const layers = personalBossPreviewLayers(bosses, [{ id: "eq-1", status: "equipped", slot: "weapon", score: 50 }]);

  assert.deepEqual(layers.slice(0, 4).map((entry) => [entry.body.bossKey, entry.body.difficulty, entry.body.affixKey]), [
    ["higher", "nightmare", "relentless"],
    ["higher", "nightmare", "blood_price"],
    ["higher", "nightmare", "none"],
    ["higher", "hard", "relentless"]
  ]);
  assert.deepEqual(layers[0].buffKeys, ["none", "assault", "guard"]);
  assert.deepEqual(layers[0].body.selectedSkillKeys, ["skill-1"]);
  assert.equal(layers[0].body.targetSlot, "weapon");
  assert.equal(layers[0].body.useMaterialBoost, true);

  bosses[1].challengeOptions.targetSlots = undefined;
  assert.equal(Object.hasOwn(personalBossPreviewLayers([bosses[1]], [
    { id: "eq-1", status: "equipped", slot: "weapon", score: 50 }
  ])[0].body, "targetSlot"), false);
});

test("personal boss layers select at most the three strongest combat skills", () => {
  const boss = personalBoss();
  boss.challengeOptions.skills = [
    { key: "low", level: 5, outputPower: 100, survivalPower: 0 },
    { key: "survival", level: 1, outputPower: 0, survivalPower: 300 },
    { key: "top", level: 4, outputPower: 250, survivalPower: 100 },
    { key: "tie-b", level: 2, outputPower: 150, survivalPower: 50 },
    { key: "tie-a", level: 2, outputPower: 150, survivalPower: 50 }
  ];

  const [layer] = personalBossPreviewLayers([boss], []);

  assert.deepEqual(layer.body.selectedSkillKeys, ["top", "survival", "tie-a"]);
});

test("personal boss layers reject blocked, unaffordable, ticketed, and exhausted candidates", () => {
  const boss = personalBoss({
    personalAttemptPool: { freeRemaining: 0 },
    difficultyOptions: [
      difficulty({ key: "ticketed", ticketCost: 1 }),
      difficulty({ key: "too-expensive", goldCost: 101, ownedGold: 100 }),
      difficulty({ key: "no-material", materialCost: 2, ownedMaterial: 1 }),
      difficulty({ key: "blocked", blockedReason: "locked" })
    ]
  });
  assert.deepEqual(personalBossPreviewLayers([boss], []), []);

  boss.personalAttemptPool.freeRemaining = 1;
  assert.deepEqual(personalBossPreviewLayers([boss], []), []);
  assert.deepEqual(personalBossPreviewLayers([{ ...boss, type: "world" }], []), []);
});

test("boss preview selection accepts 10 percent and prefers no buff on an exact tie", () => {
  const previews = [
    { buffKey: "assault", preview: { chance: 9, predictedWin: true } },
    { buffKey: "guard", preview: { chance: 88, predictedWin: true } },
    { buffKey: "none", preview: { chance: 88, predictedWin: true } }
  ];
  assert.deepEqual(chooseBossPreview(previews), previews[2]);
  assert.deepEqual(chooseBossPreview([{ buffKey: "none", preview: { chance: 10, predictedWin: true } }]), {
    buffKey: "none",
    preview: { chance: 10, predictedWin: true }
  });
  assert.equal(chooseBossPreview([{ buffKey: "none", preview: { chance: 9, predictedWin: true } }]), undefined);
  assert.equal(chooseBossPreview([{ buffKey: "none", preview: { chance: 90 } }]), undefined);
});

test("lowest scored target slot is stable and fail closed", () => {
  const equipment = [
    { id: "bag", status: "in_bag", slot: "weapon", score: 1 },
    { id: "armor", status: "equipped", slot: "armor", score: 50 },
    { id: "weapon", equipped: true, slot: "weapon", score: 50 },
    { id: "unknown", status: "equipped", slot: "ring" }
  ];
  assert.equal(lowestScoredEquippedSlot(equipment, ["weapon", "armor", "ring"]), "armor");
  assert.equal(lowestScoredEquippedSlot(equipment, ["ring"]), undefined);
});

test("best equipment upgrade chooses a strict score increase per slot", () => {
  const equipment = [
    equipmentItem({ id: "weapon-current", status: "equipped", slot: "weapon", score: 100 }),
    equipmentItem({ id: "weapon-lower", slot: "weapon", score: 99 }),
    equipmentItem({ id: "weapon-best", slot: "weapon", score: 130 }),
    equipmentItem({ id: "armor-current", status: "equipped", slot: "armor", score: 50 }),
    equipmentItem({ id: "armor-equal", slot: "armor", score: 50 })
  ];

  assert.deepEqual(chooseBestEquipmentUpgrade(equipment), {
    slot: "weapon",
    current: equipment[0],
    candidate: equipment[2],
    currentScore: 100,
    candidateScore: 130
  });
  assert.equal(chooseBestEquipmentUpgrade(equipment, new Set(["weapon"])), undefined);
});

test("best equipment upgrade ignores items above the player level", () => {
  const equipment = [
    equipmentItem({ id: "current", status: "equipped", slot: "talisman", level: 33, score: 1734 }),
    equipmentItem({ id: "too-high", slot: "talisman", level: 111, score: 2000 }),
    equipmentItem({ id: "wearable", slot: "talisman", level: 74, score: 1800 })
  ];

  assert.deepEqual(chooseBestEquipmentUpgrade(equipment, new Set(), 74), {
    slot: "talisman",
    current: equipment[0],
    candidate: equipment[2],
    currentScore: 1734,
    candidateScore: 1800
  });
});

test("best equipment upgrade fills empty slots and rejects uncertain state", () => {
  const equipment = [
    equipmentItem({ id: "boots-low", slot: "boots", score: 10 }),
    equipmentItem({ id: "boots-best", slot: "boots", score: 20 }),
    equipmentItem({ id: "ring-current", status: "equipped", slot: "ring", score: undefined }),
    equipmentItem({ id: "ring-candidate", slot: "ring", score: 100 }),
    equipmentItem({ id: "listed", status: "listed", slot: "helmet", score: 999 }),
    equipmentItem({ id: "unknown-score", slot: "armor", score: null })
  ];

  assert.deepEqual(chooseBestEquipmentUpgrade(equipment), {
    slot: "boots",
    current: undefined,
    candidate: equipment[1],
    currentScore: undefined,
    candidateScore: 20
  });
  assert.equal(chooseBestEquipmentUpgrade(equipment, new Set(["boots"])), undefined);
  assert.deepEqual(equipmentComparisonIssue(equipment), {
    slot: "ring",
    reason: "equipped-score-unknown"
  });
});

test("equipment comparison rejects multiple equipped items when an upgrade is available", () => {
  const equipment = [
    equipmentItem({ id: "first-current", status: "equipped", slot: "weapon", score: 10 }),
    equipmentItem({ id: "second-current", status: "equipped", slot: "weapon", score: 20 }),
    equipmentItem({ id: "candidate", slot: "weapon", score: 30 })
  ];

  assert.deepEqual(equipmentComparisonIssue(equipment), {
    slot: "weapon",
    reason: "multiple-equipped-items"
  });
});

test("equipment comparison ignores a bag candidate with an unknown score", () => {
  const equipment = [
    equipmentItem({ id: "current", status: "equipped", slot: "weapon", score: 10 }),
    equipmentItem({ id: "candidate", slot: "weapon", score: null })
  ];

  assert.equal(equipmentComparisonIssue(equipment), undefined);
});

test("safe decomposition includes configured qualities without affix protection", () => {
  const equipment = [
    equipmentItem({ id: "common", quality: "white", score: 1 }),
    equipmentItem({ id: "premium", quality: "white", score: 2, rareRank: "小极品" }),
    equipmentItem({ id: "unknown-rank", quality: "white", score: 3, rareRank: undefined }),
    equipmentItem({ id: "excellent", quality: "green", score: 4 }),
    equipmentItem({ id: "refined", quality: "blue", score: 5 }),
    equipmentItem({ id: "rare", quality: "purple", score: 6 }),
    equipmentItem({ id: "epic", quality: "orange", score: 7 }),
    equipmentItem({ id: "legendary", quality: "red", score: 8 }),
    equipmentItem({ id: "equipped", quality: "white", status: "equipped" }),
    equipmentItem({ id: "locked", quality: "white", locked: true })
  ];
  assert.deepEqual(safeDecompositionCandidates(equipment, {
    qualities: ["white", "green", "blue", "purple", "orange"],
    protectPremiumAffixes: false
  }).map((item) => item.id), [
    "common", "premium", "unknown-rank", "excellent", "refined", "rare", "epic"
  ]);
});

test("safe decomposition can opt in to premium and unknown affix protection", () => {
  const equipment = [
    equipmentItem({ id: "ordinary", score: 1 }),
    equipmentItem({ id: "premium", score: 2, rareRank: "小极品" }),
    equipmentItem({ id: "unknown-rank", score: 3, rareRank: undefined })
  ];
  assert.deepEqual(safeDecompositionCandidates(equipment, {
    qualities: ["white"],
    protectPremiumAffixes: true
  }).map((item) => item.id), ["ordinary"]);
  assert.equal(countProtectedDecomposition(equipment, {
    qualities: ["white"],
    protectPremiumAffixes: true
  }), 2);
});

test("safe decomposition enforces score and level ceilings and rejects empty scores", () => {
  const equipment = [
    equipmentItem({ id: "below-score-at-level", score: 99_998, level: 999 }),
    equipmentItem({ id: "at-score-limit", score: 99_999 }),
    equipmentItem({ id: "above-level-limit", score: 1, level: 1_000 }),
    equipmentItem({ id: "empty-score", score: "" }),
    equipmentItem({ id: "whitespace-score", score: "   " }),
    equipmentItem({ id: "boolean-score", score: false }),
    equipmentItem({ id: "missing-score", score: undefined })
  ];

  assert.deepEqual(safeDecompositionCandidates(equipment, {
    qualities: ["white"],
    maxLevel: 999,
    maxScore: 99_999,
    protectPremiumAffixes: false
  }).map((item) => item.id), ["below-score-at-level"]);
});

test("safe decomposition applies configured level range and stable ordering", () => {
  const equipment = [
    equipmentItem({ id: "higher-score", level: 10, score: 20 }),
    equipmentItem({ id: "lower-score", level: 10, score: 10 }),
    equipmentItem({ id: "too-low", level: 9, score: 1 }),
    equipmentItem({ id: "too-high", level: 21, score: 1 })
  ];
  assert.equal(chooseSafeDecomposition(equipment, {
    qualities: ["white"], minLevel: 10, maxLevel: 20, protectPremiumAffixes: true
  })?.id, "lower-score");
  assert.deepEqual(safeDecompositionCandidates(equipment, {
    qualities: ["white"], minLevel: 10, maxLevel: 20, protectPremiumAffixes: true
  }).map((item) => item.id), ["lower-score", "higher-score"]);
});

test("market selector buys the lowest actual one-unit gold charge within budget", () => {
  const orders = [
    marketOrder({ id: "stack", price: 600, amount: 5 }),
    marketOrder({ id: "equipment", itemType: "equipment", price: 119, amount: 1, unitPrice: 1 }),
    marketOrder({ id: "explicit-unit", price: 1000, amount: 10, unitPrice: 118 }),
    marketOrder({ id: "over", price: 301, amount: 1 }),
    marketOrder({ id: "rare", price: 1, currencyType: "rareCoin" }),
    marketOrder({ id: "request", price: 1, orderType: "buy" })
  ];
  assert.deepEqual(chooseLowestChargeMarketOrder(orders, 300), {
    order: orders[2],
    charge: 118
  });
  assert.equal(chooseLowestChargeMarketOrder([orders[3]], 300), undefined);
});

test("market selector fails closed on malformed or inactive listings", () => {
  const malformed = marketOrder({ id: "bad", price: undefined, amount: undefined });
  const inactive = marketOrder({ id: "closed", status: "closed", price: 1 });
  assert.equal(chooseLowestChargeMarketOrder([malformed, inactive], 300), undefined);
});

function personalBoss(overrides = {}) {
  return {
    key: "boss-1",
    type: "personal",
    requiredLevel: 10,
    blockedReason: "",
    personalAttemptPool: { freeRemaining: 5 },
    difficultyOptions: [difficulty({ key: "normal" }), difficulty({ key: "hard" }), difficulty({ key: "nightmare" })],
    challengeOptions: {
      skills: [{ key: "skill-1" }],
      buffs: [{ key: "none" }, { key: "assault" }, { key: "guard" }],
      affixes: [
        { key: "none", rewardMultiplier: 1 },
        { key: "blood_price", rewardMultiplier: 1.12 },
        { key: "relentless", rewardMultiplier: 1.18 }
      ],
      targetSlots: ["weapon", "armor"]
    },
    ...overrides
  };
}

function difficulty(overrides = {}) {
  return {
    key: "normal",
    blockedReason: "",
    goldCost: 0,
    ticketCost: 0,
    materialCost: 0,
    ownedGold: 100,
    ownedMaterial: 100,
    ...overrides
  };
}

function equipmentItem(overrides = {}) {
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

function marketOrder(overrides = {}) {
  return {
    id: "order-1",
    orderType: "sell",
    itemType: "material",
    status: "active",
    currencyType: "gold",
    price: 100,
    amount: 1,
    ...overrides
  };
}
