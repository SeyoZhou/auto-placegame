import { createHash } from "node:crypto";

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1_000;
const WORLD_BOSS_START_HOURS = [10, 16, 20];
export const BEIJING_TIME_ZONE = "Asia/Shanghai";

export function beijingWorldBossEvent(now = new Date()) {
  const current = validDate(now);
  const beijing = new Date(current.getTime() + BEIJING_OFFSET_MS);
  const hour = beijing.getUTCHours();
  const startHour = WORLD_BOSS_START_HOURS.find((candidate) => candidate === hour);
  if (startHour === undefined) return undefined;
  const date = beijing.toISOString().slice(0, 10);
  const start = Date.UTC(
    beijing.getUTCFullYear(),
    beijing.getUTCMonth(),
    beijing.getUTCDate(),
    startHour - 8
  );
  return {
    id: `${date}@${String(startHour).padStart(2, "0")}:00`,
    date,
    startHour,
    startAt: new Date(start).toISOString(),
    endAt: new Date(start + 60 * 60 * 1_000).toISOString()
  };
}

export function nextBeijingWorldBossStart(now = new Date()) {
  const current = validDate(now);
  const beijing = new Date(current.getTime() + BEIJING_OFFSET_MS);
  const year = beijing.getUTCFullYear();
  const month = beijing.getUTCMonth();
  const day = beijing.getUTCDate();
  for (const hour of WORLD_BOSS_START_HOURS) {
    const candidate = Date.UTC(year, month, day, hour - 8);
    if (candidate > current.getTime()) return new Date(candidate);
  }
  return new Date(Date.UTC(year, month, day + 1, WORLD_BOSS_START_HOURS[0] - 8));
}

export function worldBossCandidates(bosses = []) {
  return bosses.filter((boss) => {
    const remaining = Number(boss?.remainingAttemptCount);
    const maximum = Number(boss?.maxAttemptCount);
    return typeof boss?.bossKey === "string"
      && typeof boss?.instanceId === "string"
      && boss.status === "active"
      && !boss.assistBlockedReason
      && Number.isInteger(remaining)
      && remaining > 0
      && Number.isInteger(maximum)
      && maximum > 0;
  }).sort((left, right) => {
    return finiteNumber(left.requiredLevel, Infinity) - finiteNumber(right.requiredLevel, Infinity)
      || String(left.startedAt ?? "").localeCompare(String(right.startedAt ?? ""))
      || left.bossKey.localeCompare(right.bossKey)
      || left.instanceId.localeCompare(right.instanceId);
  });
}

export function worldBossRewardIsClaimable(boss) {
  return boss?.rewardStatus === "claimable";
}

export function formatBeijingTime(value) {
  const date = validDate(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BEIJING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
}

function validDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("current time is invalid");
  return date;
}

export function stableJitterSeconds(alias, jitterMinutes) {
  const span = Math.max(0, Math.floor(Number(jitterMinutes) * 60));
  if (span === 0) return 0;
  const value = createHash("sha256").update(String(alias)).digest().readUInt32BE(0);
  return (value % (span * 2 + 1)) - span;
}

export function effectiveMapRates(map) {
  const efficiency = finiteNumber(map?.efficiency, 0);
  return {
    exp: finiteNumber(map?.baseExpPerMin, 0) * efficiency,
    gold: finiteNumber(map?.baseGoldPerMin, 0) * efficiency
  };
}

export function chooseBestMap(maps = []) {
  const unlocked = maps.filter((map) => map?.unlocked === true);
  return unlocked.sort(compareMaps)[0];
}

export function shouldChangeMap(maps = []) {
  const current = maps.find((map) => map?.current === true);
  const best = chooseBestMap(maps);
  if (!best || !current || best.key === current.key) return { current, best, change: false };
  const candidateRates = effectiveMapRates(best);
  const currentRates = effectiveMapRates(current);
  const change = candidateRates.exp > currentRates.exp
    || (candidateRates.exp === currentRates.exp && candidateRates.gold > currentRates.gold);
  return { current, best, change };
}

function compareMaps(left, right) {
  const a = effectiveMapRates(left);
  const b = effectiveMapRates(right);
  if (a.exp !== b.exp) return b.exp - a.exp;
  if (a.gold !== b.gold) return b.gold - a.gold;
  return String(left?.key ?? "").localeCompare(String(right?.key ?? ""));
}

export function chooseAdventure(options = []) {
  if (!Array.isArray(options) || options.length === 0) {
    return { choice: undefined, reason: "no-options", parsed: [] };
  }
  const parsed = options.map((option) => ({ option, ...parseAdventureReward(option) }));
  if (parsed.some((entry) => entry.exp === undefined && entry.gold === undefined)) {
    return { choice: undefined, reason: "unknown-option", parsed };
  }
  const experience = parsed.filter((entry) => entry.exp !== undefined);
  const candidates = experience.length > 0 ? experience : parsed.filter((entry) => entry.gold !== undefined);
  candidates.sort((left, right) => {
    if (experience.length > 0) {
      if (left.exp !== right.exp) return finiteNumber(right.exp, -Infinity) - finiteNumber(left.exp, -Infinity);
      if (left.gold !== right.gold) return finiteNumber(right.gold, -Infinity) - finiteNumber(left.gold, -Infinity);
    } else if (left.gold !== right.gold) {
      return finiteNumber(right.gold, -Infinity) - finiteNumber(left.gold, -Infinity);
    }
    return String(stableKey(left.option)).localeCompare(String(stableKey(right.option)));
  });
  return { choice: candidates[0]?.option, reason: experience.length > 0 ? "experience" : "gold", parsed };
}

export function parseAdventureReward(option = {}) {
  const reward = option.reward ?? option.rewards ?? option.effect ?? {};
  const directExp = firstFinite(option.exp, option.experience, option.rewardExp, reward.exp, reward.experience);
  const directGold = firstFinite(option.gold, option.rewardGold, reward.gold);
  const text = [option.label, option.title, option.description, option.effectText, option.rewardText]
    .filter(Boolean)
    .join(" ");
  const unchanged = /(?:本次)?收益不变|收益无变化|no\s+change/i.test(text);
  return {
    exp: directExp ?? matchNumber(text, [
      /(?:经验|EXP|experience)(?:收益)?\s*[:x*]?\s*([+-]?[\d,.万千]+)\s*%?/i,
      /([+-]?[\d,.万千]+)\s*(?:点)?经验/i
    ]) ?? (unchanged ? 0 : undefined),
    gold: directGold ?? matchNumber(text, [
      /(?:金币|gold)(?:收益)?\s*[:x*]?\s*([+-]?[\d,.万千]+)\s*%?/i,
      /([+-]?[\d,.万千]+)\s*(?:枚)?金币/i
    ]) ?? (unchanged ? 0 : undefined)
  };
}

export function blackjackDecision(round = {}) {
  const hands = Array.isArray(round.hands) && round.hands.length > 0
    ? round.hands
    : [{ cards: round.playerCards ?? [] }];
  const hand = hands[Number(round.activeHandIndex ?? 0)] ?? hands[0];
  const { total, soft } = blackjackValue(hand?.cards);
  const dealer = cardValue(round.dealerCards?.[0]?.rank);
  if (soft) {
    if (total >= 19) return "stand";
    if (total === 18 && dealer >= 2 && dealer <= 8) return "stand";
    return "hit";
  }
  if (total >= 17) return "stand";
  if (total <= 11) return "hit";
  if (total === 12) return dealer >= 4 && dealer <= 6 ? "stand" : "hit";
  return dealer >= 2 && dealer <= 6 ? "stand" : "hit";
}

export function blackjackValue(cards = []) {
  let total = 0;
  let aces = 0;
  for (const card of cards ?? []) {
    const rank = card?.rank;
    if (rank === "A") {
      total += 11;
      aces += 1;
    } else {
      total += cardValue(rank);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0 };
}

export function chooseCoinLane(board = [], tokenRules = {}) {
  const candidates = board.map((lane, laneIndex) => {
    const token = lane?.[0];
    const rule = tokenRules?.[token] ?? {};
    const score = finiteNumber(rule.globalPoints, 0)
      + finiteNumber(rule.guildPoints, 0)
      + finiteNumber(rule.rewardGold, 0) / 1_000;
    return { laneIndex, token, score };
  });
  candidates.sort((left, right) => right.score - left.score || left.laneIndex - right.laneIndex);
  return candidates[0] ?? { laneIndex: 0, token: undefined, score: 0 };
}

export function lowestScoredEquippedSlot(equipment = [], allowedSlots) {
  const allowed = Array.isArray(allowedSlots) ? new Set(allowedSlots) : undefined;
  const candidates = equipment.filter((item) => {
    return isEquipmentWorn(item)
      && typeof item?.slot === "string"
      && (!allowed || allowed.has(item.slot))
      && Number.isFinite(Number(item.score ?? item.power));
  });
  candidates.sort((left, right) => {
    const score = Number(left.score ?? left.power) - Number(right.score ?? right.power);
    return score || String(left.slot).localeCompare(String(right.slot));
  });
  return candidates[0]?.slot;
}

export function chooseBestEquipmentUpgrade(equipment = [], excludedSlots = new Set(), maximumLevel = Infinity) {
  const slots = equipmentBySlot(equipment);
  const levelLimit = finiteNumber(maximumLevel, Infinity);
  const upgrades = [];
  for (const [slotName, items] of slots) {
    if (excludedSlots.has(slotName)) continue;
    const candidates = Number.isFinite(levelLimit)
      ? items.candidates.filter((item) => finiteNumber(item?.level, Infinity) <= levelLimit)
      : items.candidates;
    if (candidates.length === 0 || items.equipped.length > 1) continue;
    const current = items.equipped[0];
    const currentScore = current ? equipmentScore(current) : undefined;
    if (current && currentScore === undefined) continue;
    candidates.sort((left, right) => {
      return equipmentScore(right) - equipmentScore(left)
        || String(left.id).localeCompare(String(right.id));
    });
    const candidate = candidates[0];
    const candidateScore = equipmentScore(candidate);
    if (currentScore !== undefined && candidateScore <= currentScore) continue;
    upgrades.push({ slot: slotName, current, candidate, currentScore, candidateScore });
  }
  upgrades.sort((left, right) => left.slot.localeCompare(right.slot));
  return upgrades[0];
}

export function equipmentComparisonIssue(equipment = []) {
  for (const [slot, items] of equipmentBySlot(equipment)) {
    if (items.equipped.length > 1 && items.bagItems.length > 0) return { slot, reason: "multiple-equipped-items" };
    if (items.bagItems.length > 0 && items.equipped.length === 1 && equipmentScore(items.equipped[0]) === undefined) {
      return { slot, reason: "equipped-score-unknown" };
    }
  }
  return undefined;
}

export function isEquipmentWorn(item) {
  return item?.status === "equipped" || item?.equipped === true;
}

export function personalBossPreviewLayers(bosses = [], equipment = []) {
  const personal = bosses.filter((boss) => {
    return boss?.type === "personal"
      && typeof boss.key === "string"
      && boss.available !== false
      && !boss.blockedReason
      && Number.isFinite(Number(boss.personalAttemptPool?.freeRemaining))
      && Number(boss.personalAttemptPool.freeRemaining) > 0;
  });
  personal.sort((left, right) => {
    return finiteNumber(right.requiredLevel, -Infinity) - finiteNumber(left.requiredLevel, -Infinity)
      || String(left.key).localeCompare(String(right.key));
  });

  const layers = [];
  for (const boss of personal) {
    const options = boss.challengeOptions;
    if (!options || typeof options !== "object") continue;
    const skillKeys = strongestBossSkillKeys(options.skills);
    const buffKeys = arrayKeys(options.buffs);
    const affixes = Array.isArray(options.affixes) ? [...options.affixes] : [];
    const targetSlot = Array.isArray(options.targetSlots)
      ? lowestScoredEquippedSlot(equipment, options.targetSlots)
      : undefined;
    if (buffKeys.length === 0 || affixes.length === 0) continue;
    affixes.sort((left, right) => {
      return finiteNumber(right?.rewardMultiplier, -Infinity) - finiteNumber(left?.rewardMultiplier, -Infinity)
        || String(left?.key ?? "").localeCompare(String(right?.key ?? ""));
    });

    const difficulties = Array.isArray(boss.difficultyOptions) ? [...boss.difficultyOptions].reverse() : [];
    for (const difficulty of difficulties) {
      if (!bossDifficultyIsAffordable(difficulty)) continue;
      for (const affix of affixes) {
        if (typeof affix?.key !== "string" || !Number.isFinite(Number(affix.rewardMultiplier))) continue;
        layers.push({
          difficulty,
          buffKeys,
          rewardMultiplier: Number(affix.rewardMultiplier),
          body: {
            bossKey: boss.key,
            difficulty: difficulty.key,
            selectedSkillKeys: skillKeys,
            affixKey: affix.key,
            ...(targetSlot ? { targetSlot } : {}),
            useMaterialBoost: difficulty.key !== "normal"
          }
        });
      }
    }
  }
  return layers;
}

export function chooseBossPreview(previews = [], minimumChance = 10) {
  const eligible = previews.filter((entry) => {
    const chance = Number(entry?.preview?.chance);
    return entry?.preview?.predictedWin === true
      && Number.isFinite(chance)
      && chance >= Number(minimumChance);
  });
  eligible.sort((left, right) => {
    const chance = Number(right.preview.chance) - Number(left.preview.chance);
    if (chance) return chance;
    const noBuff = Number(right.buffKey === "none") - Number(left.buffKey === "none");
    return noBuff || String(left.buffKey).localeCompare(String(right.buffKey));
  });
  return eligible[0];
}

export function chooseSafeDecomposition(equipment = [], settings = {}) {
  return safeDecompositionCandidates(equipment, settings)[0];
}

export function safeDecompositionCandidates(equipment = [], settings = {}) {
  const criteria = decompositionCriteria(settings);
  const candidates = equipment.filter((item) => {
    return decompositionBaseEligible(item, criteria)
      && decompositionRankSafe(item, settings);
  });
  candidates.sort((left, right) => {
    return Number(left.score ?? left.power) - Number(right.score ?? right.power)
      || Number(left.level) - Number(right.level)
      || String(left.id).localeCompare(String(right.id));
  });
  return candidates;
}

export function countProtectedDecomposition(equipment = [], settings = {}) {
  if (settings.protectPremiumAffixes !== true) return 0;
  const criteria = decompositionCriteria(settings);
  return equipment.filter((item) => {
    return decompositionBaseEligible(item, criteria)
      && !decompositionRankSafe(item, settings);
  }).length;
}

export function chooseLowestChargeMarketOrder(orders = [], maximumGold = 300) {
  const budget = Number(maximumGold);
  if (!Number.isFinite(budget) || budget < 0) return undefined;
  let selected;
  for (const order of orders) {
    if (typeof order?.id !== "string"
      || (order.orderType ?? "sell") !== "sell"
      || order.status !== "active"
      || order.currencyType !== "gold") continue;
    const charge = marketOrderUnitCharge(order);
    if (!Number.isFinite(charge) || charge <= 0 || charge > budget) continue;
    if (!selected
      || charge < selected.charge
      || (charge === selected.charge && String(order.id).localeCompare(String(selected.order.id)) < 0)) {
      selected = { order, charge };
    }
  }
  return selected;
}

export function isIdleDue({ validSeconds, capacityHours = 12, intervalHours = 6, jitterSeconds = 0, urgentLeadMinutes = 30 }) {
  const pending = finiteNumber(validSeconds, 0);
  const regularAt = Math.max(0, finiteNumber(intervalHours, 6) * 3600 + finiteNumber(jitterSeconds, 0));
  const urgentAt = Math.max(0, finiteNumber(capacityHours, 12) * 3600 - finiteNumber(urgentLeadMinutes, 30) * 60);
  return pending >= Math.min(regularAt, urgentAt);
}

export function stableKey(value = {}) {
  return value.key ?? value.optionKey ?? value.id;
}

function cardValue(rank) {
  if (rank === "A") return 11;
  if (["K", "Q", "J"].includes(rank)) return 10;
  return finiteNumber(rank, 0);
}

function bossDifficultyIsAffordable(difficulty) {
  if (!difficulty || typeof difficulty.key !== "string" || difficulty.blockedReason) return false;
  const goldCost = Number(difficulty.goldCost);
  const ticketCost = Number(difficulty.ticketCost);
  const materialCost = Number(difficulty.materialCost);
  const ownedGold = Number(difficulty.ownedGold);
  const ownedMaterial = Number(difficulty.ownedMaterial);
  return [goldCost, ticketCost, materialCost, ownedGold, ownedMaterial].every(Number.isFinite)
    && goldCost >= 0
    && ticketCost === 0
    && materialCost >= 0
    && ownedGold >= goldCost
    && ownedMaterial >= materialCost;
}

function arrayKeys(values) {
  if (!Array.isArray(values)) return [];
  const keys = values.map((entry) => entry?.key);
  return keys.every((key) => typeof key === "string") ? keys : [];
}

function strongestBossSkillKeys(values, limit = 3) {
  if (!Array.isArray(values) || values.some((entry) => typeof entry?.key !== "string")) return [];
  return values
    .map((entry) => ({
      key: entry.key,
      level: finiteNumber(entry.level, 0),
      output: finiteNumber(entry.outputPower, 0),
      survival: finiteNumber(entry.survivalPower, 0)
    }))
    .sort((left, right) => {
      const total = right.output + right.survival - left.output - left.survival;
      return total
        || right.output - left.output
        || right.survival - left.survival
        || right.level - left.level
        || left.key.localeCompare(right.key);
    })
    .slice(0, limit)
    .map((entry) => entry.key);
}

function marketOrderUnitCharge(order) {
  const price = Number(order.price);
  if (order.itemType === "equipment") return price;
  const explicitUnitPrice = Number(order.unitPrice);
  if (Number.isFinite(explicitUnitPrice) && explicitUnitPrice > 0) return explicitUnitPrice;
  const amount = Number(order.amount);
  return Number.isFinite(price) && Number.isFinite(amount) && amount > 0 ? price / amount : NaN;
}

function decompositionCriteria(settings) {
  return {
    qualities: new Set(Array.isArray(settings.qualities) ? settings.qualities : []),
    minLevel: optionalFinite(settings.minLevel, -Infinity),
    maxLevel: optionalFinite(settings.maxLevel, Infinity),
    maxScore: optionalFinite(settings.maxScore, Infinity)
  };
}

function decompositionBaseEligible(item, { qualities, minLevel, maxLevel, maxScore }) {
  const level = Number(item?.level);
  const score = equipmentScore(item);
  return typeof item?.id === "string"
    && item.status === "in_bag"
    && item.locked === false
    && qualities.has(item.quality)
    && Number.isFinite(level)
    && level >= minLevel
    && level <= maxLevel
    && score !== undefined
    && score < maxScore;
}

function decompositionRankSafe(item, settings) {
  return settings.protectPremiumAffixes === true
    ? item?.rareRank === "普通装备"
    : true;
}

function equipmentScore(item) {
  const value = item?.score ?? item?.power;
  if ((typeof value !== "number" && typeof value !== "string")
    || (typeof value === "string" && value.trim() === "")) return undefined;
  const score = Number(value);
  return Number.isFinite(score) ? score : undefined;
}

function equipmentBySlot(equipment) {
  const slots = new Map();
  for (const item of equipment) {
    if (typeof item?.slot !== "string" || item.slot.length === 0) continue;
    const slot = slots.get(item.slot) ?? { equipped: [], bagItems: [], candidates: [] };
    slots.set(item.slot, slot);
    if (isEquipmentWorn(item)) {
      slot.equipped.push(item);
    } else if (item.status === "in_bag" && typeof item.id === "string") {
      slot.bagItems.push(item);
      if (equipmentScore(item) !== undefined) slot.candidates.push(item);
    }
  }
  return slots;
}

function firstFinite(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optionalFinite(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function matchNumber(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text).match(pattern);
    if (match) return parseCompactNumber(match[1]);
  }
  return undefined;
}

function parseCompactNumber(raw) {
  const value = String(raw).replaceAll(",", "");
  const multiplier = value.endsWith("万") ? 10_000 : value.endsWith("千") ? 1_000 : 1;
  const number = Number(value.replace(/[万千]$/, ""));
  return Number.isFinite(number) ? number * multiplier : undefined;
}
