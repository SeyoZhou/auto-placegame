#!/usr/bin/env node

import process from "node:process";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ApiError, PlaceGameApi, dataOf } from "./lib/placegame-api.mjs";
import {
  blackjackDecision,
  chooseAdventure,
  chooseCoinLane,
  effectiveMapRates,
  isIdleDue,
  shouldChangeMap,
  stableJitterSeconds,
  stableKey
} from "./lib/placegame-policy.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_VERSION = "0.2.35";
const DEFAULT_CONFIG = path.join(ROOT, ".placegame-accounts.local.json");
const DEFAULT_STATE = path.join(ROOT, ".placegame-state.local.json");
const DEFAULT_LOG_DIR = path.join(ROOT, ".placegame-logs");
const LOCK_FILE = path.join(ROOT, ".placegame-runtime", "run.lock");
const COMMANDS = new Set(["status", "idle", "daily", "arcade", "run"]);

class ArcadeSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArcadeSafetyError";
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  assertNodeVersion();
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const configPath = path.resolve(options.config ?? DEFAULT_CONFIG);
  await assertPrivateRegularFile(configPath, "account config");
  const config = applyDefaults(JSON.parse(await readFile(configPath, "utf8")));
  validateConfig(config);

  const statePath = path.resolve(options.state ?? DEFAULT_STATE);
  const logDir = path.resolve(options.logDir ?? DEFAULT_LOG_DIR);
  const outputWrite = dependencies.outputWrite ?? console.log;
  const state = await loadState(statePath);
  const releaseLock = await acquireLock();
  const reports = [];
  const progress = createProgressReporter({
    enabled: !options.json,
    write: dependencies.progressWrite ?? outputWrite,
    now: dependencies.now
  });
  let exitCode = 0;
  try {
    const selected = selectAccounts(config.accounts, options.account);
    progress.start({ command: options.command, total: selected.length, dryRun: options.dryRun });
    for (const [index, account] of selected) {
      const alias = account.name || `account-${index + 1}`;
      const report = { alias, command: options.command, dryRun: options.dryRun, startedAt: new Date().toISOString(), actions: [] };
      const accountProgress = progress.account({ alias, current: reports.length + 1, total: selected.length });
      try {
        const api = new PlaceGameApi({
          baseUrl: account.server ?? config.server,
          version: CLIENT_VERSION,
          timeoutMs: config.automation.requestTimeoutMs,
          fetchImpl: dependencies.fetchImpl ?? globalThis.fetch
        });
        const accountState = state.accounts[alias] ??= { actions: {} };
        accountState.actions ??= {};
        await accountProgress.stage("authentication", () => authenticate({ api, account, accountState, state, statePath }));
        await runCommand({ api, alias, accountState, state, statePath, config, options, report }, accountProgress);
        report.ok = true;
      } catch (error) {
        report.ok = false;
        report.error = safeError(error);
        exitCode = 1;
      }
      report.finishedAt = new Date().toISOString();
      accountProgress.finish({ ok: report.ok, error: report.error });
      reports.push(report);
    }
    await appendReports(logDir, reports, config.automation.logRetentionDays);
    progress.finish({
      succeeded: reports.filter((report) => report.ok).length,
      failed: reports.filter((report) => !report.ok).length
    });
  } finally {
    await releaseLock();
  }

  const output = { command: options.command, dryRun: options.dryRun, reports };
  outputWrite(options.json ? JSON.stringify(output) : `\nSummary\n${formatReports(reports)}`);
  return exitCode;
}

async function runCommand(context, progress) {
  if (context.options.command === "status") {
    await runStage(progress, context, "status", runStatus);
  } else if (context.options.command === "idle") {
    await runStage(progress, context, "idle and map", runIdle);
  } else if (context.options.command === "daily") {
    await runStage(progress, context, "daily rewards", runDaily);
  } else if (context.options.command === "arcade") {
    await runStage(progress, context, "free arcade", runArcade);
  } else {
    await runStage(progress, context, "idle and map", runIdle);
    await runStage(progress, context, "free arcade", runArcade);
    await runStage(progress, context, "daily rewards", runDaily);
  }
}

async function runStage(progress, context, label, operation) {
  const actionCount = context.report.actions.length;
  return progress.stage(
    label,
    () => operation(context),
    () => formatResultCount(context.report.actions.length - actionCount)
  );
}

async function authenticate({ api, account, accountState, state, statePath }) {
  const credentialFingerprint = createHash("sha256").update(account.username).digest("hex");
  const fingerprintChanged = accountState.credentialFingerprint !== credentialFingerprint;
  if (accountState.credentialFingerprint && accountState.credentialFingerprint !== credentialFingerprint) {
    delete accountState.session;
    delete accountState.sessionExpiresAt;
    accountState.actions = {};
  }
  accountState.credentialFingerprint = credentialFingerprint;
  if (fingerprintChanged) await saveState(statePath, state);
  if (accountState.session) {
    api.setSession(accountState.session);
    try {
      return dataOf(await api.get("/api/client/bootstrap"));
    } catch (error) {
      if (!(error instanceof ApiError) || !error.authentication) throw error;
      delete accountState.session;
      delete accountState.sessionExpiresAt;
      await saveState(statePath, state);
    }
  }
  const login = dataOf(await api.post("/api/auth/login", {
    username: account.username,
    password: account.password
  }));
  if (!login?.sessionToken) throw new Error("login did not return a Session");
  accountState.session = login.sessionToken;
  accountState.sessionExpiresAt = login.expiresAt;
  api.setSession(login.sessionToken);
  await saveState(statePath, state);
  return dataOf(await api.get("/api/client/bootstrap"));
}

async function runStatus(context) {
  const { bootstrap, idle, view, arcade, coin } = await readAllState(context.api);
  const player = bootstrap.player ?? {};
  const map = view.maps?.find((entry) => entry.current);
  context.report.summary = {
    level: player.level,
    gold: player.gold,
    currentMap: map?.key,
    effectiveRates: map ? effectiveMapRates(map) : undefined,
    idleSeconds: idle.validSeconds,
    idleCapacityHours: player.idleRewardCapacityHours,
    adventurePending: Boolean(bootstrap.idleAdventure),
    freeArcade: freeArcadeCounters(arcade),
    coinRewards: claimableCoinRewards(coin),
    claimable: claimableSummary(bootstrap, view)
  };
}

async function runIdle(context) {
  let state = await readIdleState(context.api);
  let adventureResult = await settlePendingAdventure(context, state);
  state = adventureResult.state;
  if (adventureResult.stop) {
    if (context.options.dryRun) await optimizeMap(context);
    return;
  }

  const settings = context.config.automation.idle;
  const due = isIdleDue({
    validSeconds: state.idle.validSeconds,
    capacityHours: state.bootstrap.player?.idleRewardCapacityHours ?? 12,
    intervalHours: settings.collectEveryHours,
    jitterSeconds: stableJitterSeconds(context.alias, settings.jitterMinutes),
    urgentLeadMinutes: settings.urgentLeadMinutes
  });
  if (due) {
    if (context.options.dryRun) {
      context.report.actions.push({ type: "idle-collect", status: "planned", pendingSeconds: Math.floor(state.idle.validSeconds ?? 0) });
    } else {
      const before = state;
      try {
        await context.api.post("/api/battle/idle-collect", {});
        state = await readIdleState(context.api);
        context.report.actions.push(idleOutcome("completed", before, state));
      } catch (error) {
        if (!error.ambiguous) throw error;
        state = await readIdleState(context.api);
        if (!idleWasCollected(before, state)) throw error;
        context.report.actions.push(idleOutcome("reconciled", before, state));
      }
      adventureResult = await settlePendingAdventure(context, state);
      state = adventureResult.state;
      if (adventureResult.stop) return;
    }
  } else {
    context.report.actions.push({ type: "idle-collect", status: "not-due", pendingSeconds: Math.floor(state.idle.validSeconds ?? 0) });
  }

  await optimizeMap(context);
}

async function settlePendingAdventure(context, state) {
  const adventure = state.bootstrap.idleAdventure;
  if (!adventure) return { state, stop: false };
  if (adventure) {
    const decision = chooseAdventure(adventure.options);
    const optionKey = stableKey(decision.choice);
    if (!optionKey) {
      context.report.actions.push({ type: "adventure", status: "pending", reason: decision.reason });
      return { state, stop: true };
    }
    if (context.options.dryRun) {
      context.report.actions.push({ type: "adventure", status: "planned", priority: decision.reason });
      return { state, stop: true };
    } else {
      try {
        await context.api.post("/api/battle/idle-collect", { adventureOptionKey: optionKey });
        context.report.actions.push({ type: "adventure", status: "selected", priority: decision.reason });
      } catch (error) {
        if (!error.ambiguous) throw error;
        const reconciled = await readIdleState(context.api);
        if (reconciled.bootstrap.idleAdventure) throw error;
        context.report.actions.push({ type: "adventure", status: "reconciled", priority: decision.reason });
      }
      state = await readIdleState(context.api);
    }
  }
  return { state, stop: false };
}

async function optimizeMap(context) {
  let view = dataOf(await context.api.get("/api/client/dynamic-view"));
  const decision = shouldChangeMap(view.maps);
  if (!decision.change) {
    context.report.actions.push({ type: "map", status: "unchanged", map: decision.current?.key });
    return;
  }
  if (context.options.dryRun) {
    context.report.actions.push({ type: "map", status: "planned", from: decision.current?.key, to: decision.best.key });
    return;
  }
  try {
    await context.api.post("/api/battle/change-map", { mapKey: decision.best.key });
  } catch (error) {
    if (!error.ambiguous) throw error;
    view = dataOf(await context.api.get("/api/client/dynamic-view"));
    if (!view.maps?.some((map) => map.current && map.key === decision.best.key)) throw error;
    context.report.actions.push({ type: "map", status: "reconciled", from: decision.current?.key, to: decision.best.key });
    return;
  }
  view = dataOf(await context.api.get("/api/client/dynamic-view"));
  if (!view.maps?.some((map) => map.current && map.key === decision.best.key)) throw new Error("map change was not confirmed by state refresh");
  context.report.actions.push({ type: "map", status: "changed", from: decision.current?.key, to: decision.best.key });
}

async function runDaily(context) {
  let state = await readDailyState(context.api);
  let mutations = 0;
  while (mutations < 60) {
    const action = nextDailyAction(state, context.config.automation.daily.activityRewardPoints);
    if (!action) break;
    if (context.options.dryRun) {
      context.report.actions.push({ type: action.type, status: "planned", ...(action.point ? { point: action.point } : {}) });
      state = pretendDailyClaimed(state, action);
      mutations += 1;
      continue;
    }
    try {
      await context.api.post(action.path, action.body);
      state = await readDailyState(context.api);
      if (dailyActionStillPending(state, action)) throw new Error(`${action.type} was not confirmed by state refresh`);
      context.report.actions.push({ type: action.type, status: "claimed", ...(action.point ? { point: action.point } : {}) });
    } catch (error) {
      if (!error.ambiguous) throw error;
      state = await readDailyState(context.api);
      if (dailyActionStillPending(state, action)) throw error;
      context.report.actions.push({ type: action.type, status: "reconciled", ...(action.point ? { point: action.point } : {}) });
    }
    mutations += 1;
  }
  if (mutations >= 60) throw new Error("daily claim safety limit exceeded");
  if (Number(state.view.navigation?.activityClaimableCount ?? 0) > 0) {
    context.report.actions.push({ type: "activity-reward", status: "pending", reason: "unknown-tier" });
  }
}

async function runArcade(context) {
  let state = await readArcadeState(context.api);
  const day = state.bootstrap.arcade?.key ?? state.bootstrap.daily?.key ?? "current";
  if (context.accountState.arcadeBlockedDay === day) {
    context.report.actions.push({ type: "arcade", status: "blocked-for-day", reason: "free-safety-circuit" });
    return;
  }
  try {
    if (Number(state.arcade.slot?.freeSpinsRemaining ?? 0) > 0) {
      const beforeFree = Number(state.arcade.slot.freeSpinsRemaining);
      const result = await arcadeAction(context, `arcade:${day}:slot`, "/api/arcade/slot/spin", { betGold: state.arcade.slot.minBet }, "slot");
      if (!context.options.dryRun) {
        state = await readArcadeState(context.api);
        assertFreeArcadeResult(result, "slot");
        if (Number(state.arcade.slot?.freeSpinsRemaining ?? 0) >= beforeFree) throw new ArcadeSafetyError("slot free counter did not decrease");
      }
    } else context.report.actions.push({ type: "slot", status: "no-free-attempt" });

    state = await playTreasure(context, state, day);
    state = await playBlackjack(context, state, day);
    state = await playCoinPusher(context, state, day);
    await claimCoinRewards(context, state, day);
  } catch (error) {
    if (error instanceof ArcadeSafetyError) {
      context.accountState.arcadeBlockedDay = day;
      await saveState(context.statePath, context.state);
      context.report.actions.push({ type: "arcade", status: "blocked-for-day", reason: "free-safety-circuit" });
      context.report.warnings ??= [];
      context.report.warnings.push(error.message);
      return;
    }
    throw error;
  }
}

async function playTreasure(context, state, day) {
  let round = state.bootstrap.arcade?.treasure?.currentRound;
  if (round?.status !== "active" && Number(state.arcade.treasure?.freePlaysRemaining ?? 0) > 0) {
    const result = await arcadeAction(context, `arcade:${day}:treasure:start`, "/api/arcade/treasure/start", { betGold: state.arcade.treasure.minBet }, "treasure-start");
    if (context.options.dryRun) return state;
    state = await readArcadeState(context.api);
    assertFreeArcadeResult(result, "treasure-start");
    round = state.bootstrap.arcade?.treasure?.currentRound;
  } else if (round?.status !== "active") {
    context.report.actions.push({ type: "treasure", status: "no-free-attempt" });
    return state;
  }
  if (round?.free !== true) throw new ArcadeSafetyError("active treasure round is not free; arcade stopped");
  const target = context.config.automation.arcade.treasureSafeCards;
  while (round?.status === "active" && safeTreasureCards(round) < target) {
    const revealed = new Set((round.revealed ?? []).map((card) => Number(card.index)));
    const cardIndex = [...Array(Number(state.arcade.treasure?.cardCount ?? 6)).keys()].find((index) => !revealed.has(index));
    if (cardIndex === undefined) break;
    const result = await arcadeAction(context, `arcade:${day}:treasure:${round.id}:reveal:${cardIndex}`, "/api/arcade/treasure/reveal", { cardIndex }, "treasure-reveal");
    if (context.options.dryRun) return state;
    state = await readArcadeState(context.api);
    assertFreeArcadeResult(result, "treasure-reveal", { inheritedFree: round.free });
    round = state.bootstrap.arcade?.treasure?.currentRound;
  }
  if (round?.status === "active" && Number(round.pendingGold ?? 0) > 0) {
    const result = await arcadeAction(context, `arcade:${day}:treasure:${round.id}:collect`, "/api/arcade/treasure/collect", {}, "treasure-collect");
    if (!context.options.dryRun) {
      state = await readArcadeState(context.api);
      assertFreeArcadeResult(result, "treasure-collect", { inheritedFree: round.free });
    }
  }
  return state;
}

async function playBlackjack(context, state, day) {
  let round = state.bootstrap.arcade?.blackjack?.currentRound;
  if (round?.status !== "active" && Number(state.arcade.blackjack?.freePlaysRemaining ?? 0) > 0) {
    const result = await arcadeAction(context, `arcade:${day}:blackjack:start`, "/api/arcade/blackjack/start", { betGold: state.arcade.blackjack.minBet }, "blackjack-start");
    if (context.options.dryRun) return state;
    state = await readArcadeState(context.api);
    assertFreeArcadeResult(result, "blackjack-start");
    round = state.bootstrap.arcade?.blackjack?.currentRound;
  } else if (round?.status !== "active") {
    context.report.actions.push({ type: "blackjack", status: "no-free-attempt" });
    return state;
  }
  if (round?.free !== true) throw new ArcadeSafetyError("active blackjack round is not free; arcade stopped");
  for (let decisionIndex = 0; round?.status === "active" && decisionIndex < 12; decisionIndex += 1) {
    const decision = blackjackDecision(round);
    const hand = round.hands?.[Number(round.activeHandIndex ?? 0)] ?? round.hands?.[0];
    const key = `arcade:${day}:blackjack:${round.id}:${hand?.id ?? decisionIndex}:${decision}:${hand?.cards?.length ?? 0}`;
    const result = await arcadeAction(context, key, `/api/arcade/blackjack/${decision}`, {}, `blackjack-${decision}`);
    if (context.options.dryRun) return state;
    state = await readArcadeState(context.api);
    assertFreeArcadeResult(result, `blackjack-${decision}`, { inheritedFree: round.free });
    round = state.bootstrap.arcade?.blackjack?.currentRound;
  }
  if (round?.status === "active") throw new Error("blackjack decision safety limit exceeded");
  return state;
}

async function playCoinPusher(context, state, day) {
  let free = Number(state.arcade.coinPusher?.freePushesRemaining ?? 0);
  while (free > 0) {
    const lane = chooseCoinLane(state.bootstrap.arcade?.coinPusher?.board ?? [], state.coin.config?.tokenRules ?? {});
    const result = await arcadeAction(context, `arcade:${day}:coin:remaining:${free}`, "/api/arcade/coin-pusher/push", {
      laneIndex: lane.laneIndex,
      betGold: state.coin.config?.minBet ?? state.arcade.coinPusher.minBet
    }, "coin-push");
    if (context.options.dryRun) return state;
    state = await readArcadeState(context.api);
    assertFreeArcadeResult(result?.result ?? result, "coin-push");
    const next = Number(state.arcade.coinPusher?.freePushesRemaining ?? 0);
    if (next >= free) throw new ArcadeSafetyError("coin-pusher free counter did not decrease");
    free = next;
  }
  if (free === 0) context.report.actions.push({ type: "coin-push", status: "no-free-attempt" });
  return state;
}

async function claimCoinRewards(context, state, day) {
  if (state.coin.global?.canClaim && !state.coin.global?.claimed) {
    state = await coinRewardAction(context, state, "/api/arcade/coin-pusher/claim-global", {}, "coin-global-reward", (next) => next.coin.global?.claimed === true);
  }
  for (const reward of state.coin.guild?.rewards ?? []) {
    if (!reward.canClaim || reward.claimed) continue;
    state = await coinRewardAction(
      context,
      state,
      "/api/arcade/coin-pusher/claim-guild",
      { point: reward.point },
      "coin-guild-reward",
      (next) => next.coin.guild?.rewards?.some((entry) => entry.point === reward.point && entry.claimed === true)
    );
  }
}

async function coinRewardAction(context, state, pathName, body, type, confirmed) {
  if (context.options.dryRun) {
    context.report.actions.push({ type, status: "planned" });
    return state;
  }
  try {
    await context.api.post(pathName, body);
  } catch (error) {
    if (!error.ambiguous) throw error;
    const reconciled = await readArcadeState(context.api);
    if (!confirmed(reconciled)) throw error;
    context.report.actions.push({ type, status: "reconciled" });
    return reconciled;
  }
  const refreshed = await readArcadeState(context.api);
  if (!confirmed(refreshed)) throw new Error(`${type} was not confirmed by state refresh`);
  context.report.actions.push({ type, status: "claimed" });
  return refreshed;
}

async function arcadeAction(context, operationKey, pathName, body, type) {
  if (context.options.dryRun) {
    context.report.actions.push({ type, status: "planned" });
    return undefined;
  }
  const entry = context.accountState.actions[operationKey] ??= { actionId: randomUUID(), status: "pending", createdAt: new Date().toISOString() };
  await saveState(context.statePath, context.state);
  let result;
  try {
    result = dataOf(await context.api.post(pathName, { ...body, actionId: entry.actionId }));
  } catch (error) {
    if (error.ambiguous) await context.api.get("/api/client/bootstrap").catch(() => undefined);
    throw error;
  }
  entry.status = "completed";
  entry.completedAt = new Date().toISOString();
  pruneActions(context.accountState.actions);
  await saveState(context.statePath, context.state);
  context.report.actions.push({ type, status: "completed" });
  return result;
}

export function assertFreeArcadeResult(result, type, { inheritedFree } = {}) {
  const flags = explicitValues(result, "free");
  const costs = [...explicitValues(result, "costGold"), ...explicitValues(result, "cost")];
  const free = flags.length > 0 ? flags.every((value) => value === true) : inheritedFree === true;
  const zeroCost = costs.every((value) => Number(value) === 0);
  if (!free || !zeroCost) throw new ArcadeSafetyError(`${type} was not confirmed as free and zero-cost; arcade stopped`);
}

function explicitValues(value, key, found = []) {
  if (!value || typeof value !== "object") return found;
  if (Object.hasOwn(value, key)) found.push(value[key]);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") explicitValues(child, key, found);
  }
  return found;
}

export function nextDailyAction(state, knownActivityPoints) {
  const { bootstrap, view } = state;
  const day = bootstrap.daily?.key;
  const signIn = bootstrap.retention?.signIn ?? {};
  if (day && signIn.lastClaimedKey !== day && !(signIn.claimedKeys ?? []).includes(day)) {
    return { type: "sign-in", path: "/api/retention/sign-in", body: {} };
  }
  const quest = (view.quests ?? []).find((entry) => entry.available === true && entry.completed === true && entry.claimed !== true);
  if (quest) return { type: "quest-reward", path: "/api/quests/claim", body: { questKey: quest.key }, identity: quest.key };
  const achievement = (view.achievements ?? []).find((entry) => entry.unlocked === true && entry.claimed !== true);
  if (achievement) return { type: "achievement-reward", path: "/api/achievements/claim", body: { achievementKey: achievement.key }, identity: achievement.key };
  const codex = (view.codex?.rewards ?? []).find((entry) => entry.unlocked === true && entry.claimed !== true);
  if (codex) return { type: "codex-reward", path: "/api/codex/claim", body: { rewardKey: codex.key }, identity: codex.key };
  const season = (view.rankingSeason?.rewards ?? []).find((entry) => entry.unlocked === true && entry.claimed !== true);
  if (season) return { type: "season-reward", path: "/api/ranking/season/claim", body: { rewardKey: season.key }, identity: season.key };
  const claimed = new Set(bootstrap.daily?.claimedActivity ?? []);
  if (Number(view.navigation?.activityClaimableCount ?? 0) > 0) {
    const point = knownActivityPoints.find((candidate) => !claimed.has(candidate));
    if (point !== undefined) return { type: "activity-reward", path: "/api/daily/claim", body: { point }, point };
  }
  const claimedMail = new Set(bootstrap.claimedMailRewardIds ?? []);
  const mail = (bootstrap.mails ?? []).find((entry) => entry.claimed !== true && !claimedMail.has(entry.id) && hasMailReward(entry.reward));
  if (mail) return { type: "mail-attachment", path: "/api/mail/claim", body: { mailId: mail.id }, identity: mail.id };
  return undefined;
}

function dailyActionStillPending(state, action) {
  const { bootstrap, view } = state;
  if (action.type === "sign-in") {
    const day = bootstrap.daily?.key;
    const signIn = bootstrap.retention?.signIn ?? {};
    return Boolean(day && signIn.lastClaimedKey !== day && !(signIn.claimedKeys ?? []).includes(day));
  }
  if (action.type === "quest-reward") return view.quests?.some((entry) => entry.key === action.identity && entry.available && entry.completed && !entry.claimed);
  if (action.type === "achievement-reward") return view.achievements?.some((entry) => entry.key === action.identity && entry.unlocked && !entry.claimed);
  if (action.type === "codex-reward") return view.codex?.rewards?.some((entry) => entry.key === action.identity && entry.unlocked && !entry.claimed);
  if (action.type === "season-reward") return view.rankingSeason?.rewards?.some((entry) => entry.key === action.identity && entry.unlocked && !entry.claimed);
  if (action.type === "activity-reward") return !(bootstrap.daily?.claimedActivity ?? []).includes(action.point);
  if (action.type === "mail-attachment") return (bootstrap.mails ?? []).some((entry) => entry.id === action.identity && !entry.claimed)
    && !(bootstrap.claimedMailRewardIds ?? []).includes(action.identity);
  return true;
}

function pretendDailyClaimed(state, action) {
  const clone = structuredClone(state);
  if (action.type === "sign-in") clone.bootstrap.retention.signIn.lastClaimedKey = clone.bootstrap.daily.key;
  else if (action.type === "quest-reward") clone.view.quests.find((entry) => entry.key === action.identity).claimed = true;
  else if (action.type === "achievement-reward") clone.view.achievements.find((entry) => entry.key === action.identity).claimed = true;
  else if (action.type === "codex-reward") clone.view.codex.rewards.find((entry) => entry.key === action.identity).claimed = true;
  else if (action.type === "season-reward") clone.view.rankingSeason.rewards.find((entry) => entry.key === action.identity).claimed = true;
  else if (action.type === "activity-reward") {
    clone.bootstrap.daily.claimedActivity ??= [];
    clone.bootstrap.daily.claimedActivity.push(action.point);
    clone.view.navigation.activityClaimableCount = Math.max(0, Number(clone.view.navigation.activityClaimableCount) - 1);
  } else if (action.type === "mail-attachment") clone.bootstrap.mails.find((entry) => entry.id === action.identity).claimed = true;
  return clone;
}

async function readAllState(api) {
  const [bootstrap, idle, view, arcade, coin] = await Promise.all([
    api.get("/api/client/bootstrap"),
    api.get("/api/client/idle-summary"),
    api.get("/api/client/dynamic-view"),
    api.get("/api/arcade/view"),
    api.get("/api/arcade/coin-pusher/view")
  ]);
  return { bootstrap: dataOf(bootstrap), idle: dataOf(idle), view: dataOf(view), arcade: dataOf(arcade), coin: dataOf(coin) };
}

async function readIdleState(api) {
  const [bootstrap, idle] = await Promise.all([api.get("/api/client/bootstrap"), api.get("/api/client/idle-summary")]);
  return { bootstrap: dataOf(bootstrap), idle: dataOf(idle) };
}

async function readDailyState(api) {
  const [bootstrap, view] = await Promise.all([api.get("/api/client/bootstrap"), api.get("/api/client/dynamic-view")]);
  return { bootstrap: dataOf(bootstrap), view: dataOf(view) };
}

async function readArcadeState(api) {
  const [bootstrap, arcade, coin] = await Promise.all([
    api.get("/api/client/bootstrap"),
    api.get("/api/arcade/view"),
    api.get("/api/arcade/coin-pusher/view")
  ]);
  return { bootstrap: dataOf(bootstrap), arcade: dataOf(arcade), coin: dataOf(coin) };
}

function idleWasCollected(before, after) {
  return Number(after.idle.validSeconds ?? 0) + 60 < Number(before.idle.validSeconds ?? 0)
    || Number(after.bootstrap.daily?.collectCount ?? 0) > Number(before.bootstrap.daily?.collectCount ?? 0);
}

function idleOutcome(status, before, after) {
  return {
    type: "idle-collect",
    status,
    pendingSeconds: Math.floor(before.idle.validSeconds ?? 0),
    goldDelta: Number(after.bootstrap.player?.gold ?? 0) - Number(before.bootstrap.player?.gold ?? 0),
    levelDelta: Number(after.bootstrap.player?.level ?? 0) - Number(before.bootstrap.player?.level ?? 0)
  };
}

function safeTreasureCards(round) {
  return (round.revealed ?? []).filter((card) => card.kind !== "trap").length;
}

function freeArcadeCounters(arcade) {
  return {
    slot: arcade.slot?.freeSpinsRemaining,
    treasure: arcade.treasure?.freePlaysRemaining,
    blackjack: arcade.blackjack?.freePlaysRemaining,
    coin: arcade.coinPusher?.freePushesRemaining
  };
}

function claimableCoinRewards(coin) {
  return {
    global: Boolean(coin.global?.canClaim && !coin.global?.claimed),
    guild: (coin.guild?.rewards ?? []).filter((reward) => reward.canClaim && !reward.claimed).length
  };
}

function claimableSummary(bootstrap, view) {
  const day = bootstrap.daily?.key;
  const signIn = bootstrap.retention?.signIn ?? {};
  return {
    signIn: Boolean(day && signIn.lastClaimedKey !== day && !(signIn.claimedKeys ?? []).includes(day)),
    quests: (view.quests ?? []).filter((entry) => entry.available && entry.completed && !entry.claimed).length,
    achievements: (view.achievements ?? []).filter((entry) => entry.unlocked && !entry.claimed).length,
    codex: (view.codex?.rewards ?? []).filter((entry) => entry.unlocked && !entry.claimed).length,
    season: (view.rankingSeason?.rewards ?? []).filter((entry) => entry.unlocked && !entry.claimed).length,
    activity: Number(view.navigation?.activityClaimableCount ?? 0),
    mail: (bootstrap.mails ?? []).filter((entry) => !entry.claimed && hasMailReward(entry.reward)).length
  };
}

function hasMailReward(reward) {
  if (!reward || typeof reward !== "object") return false;
  if ((reward.items ?? []).some((entry) => Number(entry?.amount ?? 0) > 0)) return true;
  return Object.entries(reward).some(([key, value]) => key !== "items" && Number(value) > 0);
}

function assertNodeVersion() {
  const major = Number(process.versions.node.split(".", 1)[0]);
  if (!Number.isInteger(major) || major < 24) throw new Error("Node.js 24 or newer is required");
}

function applyDefaults(config) {
  const automation = config.automation ?? {};
  return {
    ...config,
    server: config.server ?? "https://api.placegame.cn",
    automation: {
      requestTimeoutMs: automation.requestTimeoutMs ?? 25_000,
      logRetentionDays: automation.logRetentionDays ?? 30,
      idle: {
        collectEveryHours: automation.idle?.collectEveryHours ?? 6,
        jitterMinutes: automation.idle?.jitterMinutes ?? 12,
        urgentLeadMinutes: automation.idle?.urgentLeadMinutes ?? 30
      },
      arcade: { treasureSafeCards: automation.arcade?.treasureSafeCards ?? 2 },
      daily: { activityRewardPoints: automation.daily?.activityRewardPoints ?? [20] }
    }
  };
}

function validateConfig(config) {
  if (!Array.isArray(config.accounts) || config.accounts.length === 0) throw new Error("account config contains no accounts");
  const names = new Set();
  for (const [index, account] of config.accounts.entries()) {
    if (!account?.username || !account?.password) throw new Error(`account-${index + 1} is missing username or password`);
    const alias = account.name || `account-${index + 1}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias)) {
      throw new Error("account aliases must be 1-64 ASCII letters, digits, dots, underscores, or hyphens");
    }
    if (alias === account.username) throw new Error("account aliases must not equal usernames because aliases appear in reports");
    if (names.has(alias)) throw new Error("account aliases must be unique");
    names.add(alias);
  }
  if (Number(config.automation.idle.collectEveryHours) <= 0) throw new Error("idle interval must be positive");
  if (!Number.isInteger(config.automation.logRetentionDays) || config.automation.logRetentionDays < 1) throw new Error("logRetentionDays must be a positive integer");
  if (Number(config.automation.arcade.treasureSafeCards) < 1) throw new Error("treasureSafeCards must be at least 1");
  const points = config.automation.daily.activityRewardPoints;
  if (!Array.isArray(points) || points.some((point) => !Number.isInteger(point) || point < 1)) {
    throw new Error("activityRewardPoints must be an array of positive integers");
  }
}

function selectAccounts(accounts, requested) {
  const indexed = accounts.map((account, index) => [index, account]);
  if (!requested) return indexed;
  const selected = indexed.filter(([index, account]) => (account.name || `account-${index + 1}`) === requested);
  if (selected.length === 0) throw new Error("requested account alias does not exist");
  return selected;
}

function parseArgs(argv) {
  const options = { command: "run", config: undefined, state: undefined, logDir: undefined, account: undefined, dryRun: false, json: false, help: false };
  const args = [...argv];
  if (args[0] && !args[0].startsWith("--")) options.command = args.shift();
  if (!COMMANDS.has(options.command)) throw new Error(`unknown command: ${options.command}`);
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--dry-run") options.dryRun = true;
    else if (token === "--json") options.json = true;
    else if (token === "--help" || token === "-h") options.help = true;
    else if (["--config", "--state", "--log-dir", "--account"].includes(token)) {
      const value = args.shift();
      if (!value) throw new Error(`${token} requires a value`);
      options[token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    } else throw new Error(`unknown option: ${token}`);
  }
  return options;
}

async function assertPrivateRegularFile(filePath, label) {
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  if ((info.mode & 0o777) !== 0o600) throw new Error(`${label} must have mode 0600; run: chmod 600 ${filePath}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`${label} must be owned by the current user`);
}

async function loadState(statePath) {
  try {
    await assertPrivateRegularFile(statePath, "runtime state");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.accounts ??= {};
    return state;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { version: 1, accounts: {} };
  }
}

async function saveState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, statePath);
  await chmod(statePath, 0o600);
}

async function acquireLock() {
  await ensurePrivateDirectory(path.dirname(LOCK_FILE), "runtime directory");
  let handle;
  try {
    handle = await open(LOCK_FILE, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const lockInfo = await lstat(LOCK_FILE);
    if (lockInfo.isSymbolicLink() || !lockInfo.isFile()) throw new Error("run lock must be a regular non-symlink file");
    let running = true;
    try {
      const pid = Number(await readFile(LOCK_FILE, "utf8"));
      if (!Number.isInteger(pid) || pid < 1) running = false;
      else process.kill(pid, 0);
    } catch (checkError) {
      if (checkError.code === "ESRCH" || checkError instanceof SyntaxError) running = false;
      else if (checkError.code === "ENOENT") return acquireLock();
    }
    if (running) throw new Error("another automation process is already running");
    await unlink(LOCK_FILE);
    return acquireLock();
  }
  await handle.writeFile(String(process.pid));
  await handle.close();
  return async () => {
    try { await unlink(LOCK_FILE); } catch (error) { if (error.code !== "ENOENT") throw error; }
  };
}

async function appendReports(logDir, reports, retentionDays) {
  await ensurePrivateDirectory(logDir, "log directory");
  const day = new Date().toISOString().slice(0, 10);
  const logPath = path.join(logDir, `${day}.jsonl`);
  try {
    await assertPrivateRegularFile(logPath, "daily log");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const handle = await open(logPath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
  try {
    for (const report of reports) await handle.appendFile(`${JSON.stringify(report)}\n`);
  } finally {
    await handle.close();
  }
  await chmod(logPath, 0o600);
  await pruneLogs(logDir, retentionDays, day);
}

async function ensurePrivateDirectory(directoryPath, label) {
  try {
    const directory = await lstat(directoryPath);
    if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error(`${label} must be a non-symlink directory`);
    if (typeof process.getuid === "function" && directory.uid !== process.getuid()) throw new Error(`${label} must be owned by the current user`);
    await chmod(directoryPath, 0o700);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    const directory = await lstat(directoryPath);
    if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error(`${label} must be a non-symlink directory`);
  }
}

async function pruneLogs(logDir, retentionDays, currentDay) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1_000;
  for (const name of await readdir(logDir)) {
    const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!match || match[1] === currentDay) continue;
    const timestamp = Date.parse(`${match[1]}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || timestamp >= cutoff) continue;
    const candidate = path.join(logDir, name);
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isFile()) continue;
    await unlink(candidate);
  }
}

function pruneActions(actions) {
  const completed = Object.entries(actions)
    .filter(([, value]) => value.status === "completed")
    .sort((left, right) => String(right[1].completedAt).localeCompare(String(left[1].completedAt)));
  for (const [key] of completed.slice(100)) delete actions[key];
}

function safeError(error) {
  if (error instanceof ApiError) return `${error.path ?? "request"}: ${error.authentication ? "authentication rejected" : error.ambiguous ? "outcome uncertain after network failure" : "request rejected"}`;
  return String(error?.message ?? "unknown error").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

export function createProgressReporter({ enabled = true, write = console.log, now = () => Date.now() } = {}) {
  if (!enabled) return createSilentProgressReporter();
  const startedAt = now();
  let writable = true;
  const safeWrite = (line) => {
    if (!writable) return;
    try {
      write(line);
    } catch {
      writable = false;
    }
  };

  return {
    start({ command, total, dryRun }) {
      safeWrite(`Starting ${command}${dryRun ? " dry run" : ""} for ${total} ${pluralize(total, "account")}.`);
    },
    account({ alias, current, total }) {
      const prefix = `[${current}/${total}] ${alias}`;
      const accountStartedAt = now();
      safeWrite(`${prefix}: starting`);
      return {
        async stage(label, operation, describeResult) {
          const stageStartedAt = now();
          safeWrite(`${prefix}: ${label}...`);
          try {
            const result = await operation();
            const detail = describeResult?.(result);
            safeWrite(`${prefix}: ${label} done (${formatDuration(now() - stageStartedAt)}${detail ? `, ${detail}` : ""})`);
            return result;
          } catch (error) {
            safeWrite(`${prefix}: ${label} failed (${formatDuration(now() - stageStartedAt)}): ${safeError(error)}`);
            throw error;
          }
        },
        finish({ ok, error }) {
          safeWrite(`${prefix}: ${ok ? "completed" : `failed (${error})`} (${formatDuration(now() - accountStartedAt)})`);
        }
      };
    },
    finish({ succeeded, failed }) {
      safeWrite(`Finished: ${succeeded} succeeded, ${failed} failed (${formatDuration(now() - startedAt)}).`);
    }
  };
}

function createSilentProgressReporter() {
  return {
    start() {},
    account() {
      return {
        stage(_label, operation) { return operation(); },
        finish() {}
      };
    },
    finish() {}
  };
}

function formatDuration(milliseconds) {
  return `${(Math.max(0, milliseconds) / 1_000).toFixed(1)}s`;
}

function formatResultCount(count) {
  return `${count} ${pluralize(count, "result")}`;
}

function pluralize(count, singular) {
  return count === 1 ? singular : `${singular}s`;
}

function formatReports(reports) {
  const lines = [];
  for (const report of reports) {
    lines.push(`${report.alias}: ${report.ok ? "ok" : `error (${report.error})`}`);
    if (report.summary) lines.push(`  ${JSON.stringify(report.summary)}`);
    for (const action of report.actions) lines.push(`  ${action.type}: ${action.status}`);
    for (const warning of report.warnings ?? []) lines.push(`  warning: ${warning}`);
  }
  return lines.join("\n");
}

function printHelp() {
  console.log(`PlaceGame daily automation\n\nUsage:\n  node placegame-auto.mjs [run|status|idle|daily|arcade] [options]\n\nOptions:\n  --config <path>   Account config (default: .placegame-accounts.local.json)\n  --state <path>    Private Session/action state\n  --log-dir <path>  Redacted JSONL report directory\n  --account <alias> Run one configured account\n  --dry-run         Read state and report planned mutations\n  --json            Print structured output\n  --help            Show this help`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`placegame-auto: ${safeError(error)}`);
    process.exitCode = 1;
  });
}
