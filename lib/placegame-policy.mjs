import { createHash } from "node:crypto";

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
  return {
    exp: directExp ?? matchNumber(text, [/(?:经验|EXP|experience)\s*[+:x*]?\s*([\d,.万千]+)/i, /([\d,.万千]+)\s*(?:点)?经验/i]),
    gold: directGold ?? matchNumber(text, [/(?:金币|gold)\s*[+:x*]?\s*([\d,.万千]+)/i, /([\d,.万千]+)\s*(?:枚)?金币/i])
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
