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
  chooseBestEquipmentUpgrade,
  chooseBossPreview,
  chooseCoinLane,
  chooseLowestChargeMarketOrder,
  countProtectedDecomposition,
  equipmentComparisonIssue,
  effectiveMapRates,
  isIdleDue,
  isEquipmentWorn,
  personalBossPreviewLayers,
  safeDecompositionCandidates,
  shouldChangeMap,
  stableJitterSeconds,
  stableKey
} from "./lib/placegame-policy.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(ROOT, ".placegame-accounts.local.json");
const DEFAULT_STATE = path.join(ROOT, ".placegame-state.local.json");
const DEFAULT_LOG_DIR = path.join(ROOT, ".placegame-logs");
const LOCK_FILE = path.join(ROOT, ".placegame-runtime", "run.lock");
const COMMANDS = new Set(["status", "idle", "daily", "arcade", "boss", "run"]);
const BOSS_MINIMUM_CHANCE = 80;
const BOSS_SUBMISSION_LIMIT = 20;
const KNOWN_ACTIVITY_POINTS = [20, 40, 60, 80, 100];
const ACTIVITY_TARGET = 100;
const ACTIVITY_MUTATION_LIMIT = 60;
const EQUIPMENT_WEAR_LIMIT = 60;
const DECOMPOSITION_BATCH_SIZE = 50;
const DAILY_REWARD_LIMIT_IDENTITY = "daily-rewards:mutation-limit";
const QUALITY_ALIASES = {
  common: "white",
  normal: "white",
  white: "white",
  excellent: "green",
  green: "green",
  refined: "blue",
  blue: "blue",
  rare: "purple",
  purple: "purple",
  epic: "orange",
  orange: "orange",
  legendary: "red",
  red: "red",
  mythic: "gold",
  gold: "gold"
};
const QUALITY_KEYS = new Set(Object.values(QUALITY_ALIASES));

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
  const clientVersions = new Map();
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
      const server = account.server ?? config.server;
      let api;
      try {
        api = new PlaceGameApi({
          baseUrl: server,
          version: clientVersions.get(server),
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
      if (api) clientVersions.set(server, api.version);
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
    await runStage(progress, context, "best equipment", runBestEquipment);
    await runBestEffortBossStage(progress, context);
    await runStage(progress, context, "daily rewards", runDaily);
  } else if (context.options.command === "arcade") {
    await runStage(progress, context, "free arcade", runArcade);
  } else if (context.options.command === "boss") {
    await runStage(progress, context, "best equipment", runBestEquipment);
    await runStage(progress, context, "personal boss", runPersonalBoss);
  } else {
    await runStage(progress, context, "idle and map", runIdle);
    await runStage(progress, context, "free arcade", runArcade);
    await runStage(progress, context, "best equipment", runBestEquipment);
    await runBestEffortBossStage(progress, context);
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

async function runBestEffortBossStage(progress, context) {
  const label = "personal boss";
  try {
    return await runStage(progress, context, label, runPersonalBoss);
  } catch (error) {
    context.report.actions.push({ type: "personal-boss", status: "failed", reason: safeError(error) });
    context.report.warnings ??= [];
    context.report.warnings.push(`${label}: ${safeError(error)}`);
  }
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

export async function runDaily(context) {
  let state = await readDailyState(context.api);
  if (state.guild?.unavailable === true) {
    context.report.actions.push({ type: "guild-progress-reward", status: "unavailable", reason: "state-read-failed" });
    context.report.warnings ??= [];
    context.report.warnings.push(`guild rewards: ${state.guild.reason}`);
  } else if (state.guild?.joined === false) {
    context.report.actions.push({ type: "guild-progress-reward", status: "unavailable", reason: "not-member" });
  }
  const targetEnabled = context.config.automation.daily.activityRewardPoints.includes(ACTIVITY_TARGET);
  const initiallyComplete = activityTierClaimed(state, ACTIVITY_TARGET);
  const failedRewards = new Set();
  const activitySafety = { blocked: false };
  state = await claimDailyRewards(context, state, failedRewards, activitySafety);
  const equipmentResult = await runBestEquipment(context);
  state = await cleanEquipmentAndPursueActivity(
    context,
    state,
    failedRewards,
    activitySafety,
    equipmentResult,
    targetEnabled
  );
  if (!context.options.dryRun && activityStateKnown(state)) {
    state = await claimDailyRewards(context, state, failedRewards, activitySafety);
    await runBestEquipment(context);
  }
  reportActivityOutcome(context, state, initiallyComplete, failedRewards, targetEnabled);
}

export async function runBestEquipment(context) {
  const skippedSlots = new Set();
  let safeForDecomposition = true;
  let unsafeReason;
  let equipment;
  try {
    equipment = await readEquipment(context.api);
  } catch (error) {
    context.report.actions.push({ type: "equipment-wear", status: "failed", reason: safeError(error) });
    return { safeForDecomposition: false, equipment: undefined, reason: "equipment-state-read-failed" };
  }
  let mutations = 0;
  while (mutations < EQUIPMENT_WEAR_LIMIT) {
    const upgrade = chooseBestEquipmentUpgrade(equipment, skippedSlots);
    if (!upgrade) {
      const issue = equipmentComparisonIssue(equipment);
      if (issue) {
        context.report.actions.push({ type: "equipment-wear", status: "stopped", ...issue });
        return { safeForDecomposition: false, equipment, reason: issue.reason };
      }
      return { safeForDecomposition, equipment, reason: unsafeReason };
    }
    const action = {
      type: "equipment-wear",
      slot: upgrade.slot,
      fromScore: upgrade.currentScore,
      toScore: upgrade.candidateScore
    };
    if (context.options.dryRun) {
      context.report.actions.push({ ...action, status: "planned" });
      equipment = simulateEquipmentWear(equipment, upgrade);
      mutations += 1;
      continue;
    }

    let ambiguous = false;
    try {
      await context.api.post("/api/equipment/wear", { equipmentId: upgrade.candidate.id });
    } catch (error) {
      if (!error.ambiguous) {
        context.report.actions.push({ ...action, status: "failed", reason: safeError(error) });
        safeForDecomposition = false;
        unsafeReason ??= "equipment-wear-failed";
        skippedSlots.add(upgrade.slot);
        continue;
      }
      ambiguous = true;
    }
    mutations += 1;
    try {
      equipment = await readEquipment(context.api);
    } catch (error) {
      context.report.actions.push({
        ...action,
        status: "uncertain",
        reason: ambiguous ? "outcome-unknown" : `state-refresh-failed: ${safeError(error)}`
      });
      return {
        safeForDecomposition: false,
        equipment,
        reason: ambiguous ? "equipment-wear-outcome-unknown" : "equipment-state-refresh-failed"
      };
    }
    if (!equipment.some((item) => item?.id === upgrade.candidate.id && isEquipmentWorn(item))) {
      context.report.actions.push({ ...action, status: "uncertain", reason: "state-not-confirmed" });
      safeForDecomposition = false;
      unsafeReason ??= "equipment-wear-not-confirmed";
      skippedSlots.add(upgrade.slot);
      continue;
    }
    context.report.actions.push({ ...action, status: ambiguous ? "reconciled" : "completed" });
  }

  if (chooseBestEquipmentUpgrade(equipment, skippedSlots)) {
    context.report.actions.push({ type: "equipment-wear", status: "stopped", reason: "mutation-limit" });
    return { safeForDecomposition: false, equipment, reason: "equipment-wear-mutation-limit" };
  }
  return { safeForDecomposition, equipment, reason: unsafeReason };
}

function simulateEquipmentWear(equipment, upgrade) {
  return equipment.map((item) => {
    if (item?.id === upgrade.candidate.id) return { ...item, status: "equipped", equipped: true };
    if (item?.id === upgrade.current?.id) return { ...item, status: "in_bag", equipped: false };
    return item;
  });
}

async function claimDailyRewards(context, initialState, failedRewards, activitySafety) {
  let state = initialState;
  let mutations = 0;
  const dryRunPlanned = new Set();
  while (mutations < ACTIVITY_MUTATION_LIMIT) {
    const excludedRewards = dryRunPlanned.size > 0
      ? new Set([...failedRewards, ...dryRunPlanned])
      : failedRewards;
    const action = nextDailyAction(state, context.config.automation.daily.activityRewardPoints, excludedRewards);
    if (!action) break;
    const identity = dailyActionIdentity(action, state);
    if (context.options.dryRun) {
      context.report.actions.push(dailyActionReport(action, "planned"));
      if (action.type === "activity-reward") dryRunPlanned.add(identity);
      else state = pretendDailyClaimed(state, action);
      mutations += 1;
      continue;
    }

    try {
      await context.api.post(action.path, action.body);
    } catch (error) {
      if (error.ambiguous) {
        state = await readDailyState(context.api);
        const outcome = dailyActionOutcome(state, action);
        if (outcome === "claimed") {
          context.report.actions.push(dailyActionReport(action, "reconciled"));
        } else {
          failedRewards.add(identity);
          if (action.type === "activity-reward" && action.point === ACTIVITY_TARGET) {
            activitySafety.blocked = true;
          }
          context.report.actions.push({
            ...dailyActionReport(action, outcome === "unknown" ? "uncertain" : "failed"),
            reason: outcome === "unknown" ? "claim outcome was not available after state refresh" : safeError(error)
          });
        }
      } else {
        failedRewards.add(identity);
        context.report.actions.push({ ...dailyActionReport(action, "failed"), reason: safeError(error) });
      }
      mutations += 1;
      continue;
    }

    state = await readDailyState(context.api);
    const outcome = dailyActionOutcome(state, action);
    if (outcome !== "claimed") {
      failedRewards.add(identity);
      if (action.type === "activity-reward" && action.point === ACTIVITY_TARGET) {
        activitySafety.blocked = true;
      }
      context.report.actions.push({
        ...dailyActionReport(action, outcome === "unknown" ? "uncertain" : "failed"),
        reason: outcome === "unknown"
          ? `${action.type} could not be confirmed because refreshed state omitted its collection`
          : `${action.type} was not confirmed by state refresh`
      });
    } else {
      context.report.actions.push(dailyActionReport(action, "claimed"));
    }
    mutations += 1;
  }
  if (mutations >= ACTIVITY_MUTATION_LIMIT
    && nextDailyAction(state, context.config.automation.daily.activityRewardPoints, failedRewards)) {
    failedRewards.add(DAILY_REWARD_LIMIT_IDENTITY);
    context.report.actions.push({ type: "daily-rewards", status: "stopped", reason: "mutation-limit" });
  }
  return state;
}

async function cleanEquipmentAndPursueActivity(
  context,
  initialState,
  failedRewards,
  activitySafety,
  initialEquipmentResult,
  targetEnabled
) {
  let state = initialState;
  let equipmentResult = initialEquipmentResult;
  const settings = context.config.automation.daily;
  const skippedEquipment = new Set();
  let consecutivePreviewFailures = 0;
  if (context.options.dryRun && equipmentResult.safeForDecomposition) {
    const protectedCount = countProtectedDecomposition(equipmentResult.equipment, settings.decomposition);
    if (protectedCount > 0) {
      context.report.actions.push({
        type: "equipment-decompose",
        status: "protected",
        reason: "premium-or-unknown-affix",
        count: protectedCount
      });
    }
  }
  while (true) {
    if (!equipmentResult.safeForDecomposition) {
      context.report.actions.push({
        type: "equipment-decompose",
        status: "stopped",
        reason: equipmentResult.reason ?? "equipment-comparison-unsafe"
      });
      return state;
    }
    const equipment = equipmentResult.equipment;
    const candidates = safeDecompositionCandidates(equipment, settings.decomposition)
      .filter((item) => !skippedEquipment.has(item.id))
      .slice(0, DECOMPOSITION_BATCH_SIZE);
    if (candidates.length === 0) break;
    const equipmentIds = candidates.map((candidate) => candidate.id);
    if (context.options.dryRun) {
      for (const candidate of candidates) {
        context.report.actions.push({
          type: "equipment-decompose",
          status: "planned",
          quality: candidate.quality,
          level: candidate.level,
          reason: "daily-cleanup"
        });
        skippedEquipment.add(candidate.id);
      }
      continue;
    }

    try {
      const preview = dataOf(await context.api.post("/api/equipment/decompose-preview", { equipmentIds }));
      if (!safeDecompositionPreview(preview, equipmentIds)) {
        for (const equipmentId of equipmentIds) skippedEquipment.add(equipmentId);
        consecutivePreviewFailures = 0;
        context.report.actions.push({ type: "equipment-decompose", status: "skipped", count: equipmentIds.length, reason: "preview-unconfirmed" });
        continue;
      }
      consecutivePreviewFailures = 0;
    } catch (error) {
      context.report.actions.push({ type: "equipment-decompose", status: "failed", count: equipmentIds.length, reason: safeError(error) });
      if (transientRequestFailure(error)) {
        consecutivePreviewFailures += 1;
        if (consecutivePreviewFailures >= 3) {
          context.report.actions.push({ type: "equipment-decompose", status: "stopped", reason: "preview-failure-limit" });
          return state;
        }
      } else {
        for (const equipmentId of equipmentIds) skippedEquipment.add(equipmentId);
        consecutivePreviewFailures = 0;
      }
      continue;
    }

    const beforeCount = finiteCounter(state.bootstrap.daily?.decomposeCount);
    let ambiguousError;
    try {
      await context.api.post("/api/equipment/decompose", { equipmentIds });
    } catch (error) {
      if (!error.ambiguous) {
        for (const equipmentId of equipmentIds) skippedEquipment.add(equipmentId);
        context.report.actions.push({ type: "equipment-decompose", status: "failed", count: equipmentIds.length, reason: safeError(error) });
        continue;
      }
      ambiguousError = error;
    }
    const [refreshedState, refreshedEquipment] = await Promise.all([
      readDailyState(context.api),
      readEquipment(context.api)
    ]);
    state = refreshedState;
    const remainingEquipmentIds = new Set(refreshedEquipment.map((item) => item?.id));
    const confirmed = counterIncreased(beforeCount, state.bootstrap.daily?.decomposeCount)
      && equipmentIds.every((equipmentId) => !remainingEquipmentIds.has(equipmentId));
    if (!confirmed) {
      context.report.actions.push({
        type: "equipment-decompose",
        status: "uncertain",
        count: equipmentIds.length,
        reason: ambiguousError ? "outcome-unknown" : "state-not-confirmed"
      });
      return state;
    }
    context.report.actions.push({
      type: "equipment-decompose",
      status: ambiguousError ? "reconciled" : "completed",
      count: equipmentIds.length
    });
    if (targetEnabled
      && activityStateKnown(state)
      && !activityTierClaimed(state, ACTIVITY_TARGET)
      && !activityPursuitBlocked(failedRewards, activitySafety)) {
      allowActivityRewardRetry(failedRewards);
      state = await claimDailyRewards(context, state, failedRewards, activitySafety);
      equipmentResult = await runBestEquipment(context);
    } else {
      equipmentResult = { safeForDecomposition: true, equipment: refreshedEquipment };
    }
  }
  if (!targetEnabled) return state;
  if (!activityStateKnown(state)) {
    context.report.actions.push({ type: "activity-target", status: "stopped", reason: "unknown-activity-state" });
    return state;
  }
  if (activityPursuitBlocked(failedRewards, activitySafety)) {
    context.report.actions.push({ type: "activity-target", status: "stopped", reason: "reward-claim-blocked" });
    return state;
  }
  if (activityTierClaimed(state, ACTIVITY_TARGET)) return state;
  return purchaseActivityItem(context, state, failedRewards, activitySafety);
}

async function purchaseActivityItem(context, state, failedRewards, activitySafety) {
  const marketBuyCount = finiteCounter(state.bootstrap.daily?.marketBuyCount);
  if (marketBuyCount === undefined) {
    context.report.actions.push({ type: "market-buy", status: "skipped", reason: "unknown-daily-count" });
    return state;
  }
  if (marketBuyCount > 0) {
    context.report.actions.push({ type: "market-buy", status: "skipped", reason: "daily-purchase-used" });
    return state;
  }
  const ordersData = dataOf(await context.api.get("/api/market/orders"));
  const orders = Array.isArray(ordersData) ? ordersData : ordersData?.orders ?? [];
  const selected = chooseLowestChargeMarketOrder(orders, context.config.automation.daily.marketMaxGold);
  if (!selected) {
    context.report.actions.push({ type: "market-buy", status: "skipped", reason: "no-eligible-order" });
    return state;
  }
  if (context.options.dryRun) {
    context.report.actions.push({
      type: "market-buy",
      status: "planned",
      quantity: 1,
      projectedGold: selected.charge,
      reason: "if-activity-target-remains"
    });
    return state;
  }

  let ambiguousError;
  try {
    await context.api.post("/api/market/buy", { orderId: selected.order.id, quantity: 1 });
  } catch (error) {
    if (!error.ambiguous) {
      context.report.actions.push({ type: "market-buy", status: "failed", projectedGold: selected.charge, reason: safeError(error) });
      return state;
    }
    ambiguousError = error;
  }
  state = await readDailyState(context.api);
  if (!counterIncreased(marketBuyCount, state.bootstrap.daily?.marketBuyCount)) {
    context.report.actions.push({ type: "market-buy", status: "uncertain", projectedGold: selected.charge, reason: "outcome-unknown" });
    return state;
  }
  context.report.actions.push({
    type: "market-buy",
    status: ambiguousError ? "reconciled" : "completed",
    quantity: 1,
    projectedGold: selected.charge
  });
  allowActivityRewardRetry(failedRewards);
  state = await claimDailyRewards(context, state, failedRewards, activitySafety);
  return state;
}

function reportActivityOutcome(context, state, initiallyComplete, failedRewards, targetEnabled) {
  if (!activityStateKnown(state)) {
    context.report.activity = {
      status: "incomplete",
      claimed: [],
      remaining: [...context.config.automation.daily.activityRewardPoints],
      failedRewards: failedRewards.size,
      reason: "unknown-activity-state"
    };
    context.report.actions.push({
      type: "activity-target",
      status: "pending",
      point: ACTIVITY_TARGET,
      reason: "unknown-activity-state"
    });
    return;
  }
  const claimed = new Set(state.bootstrap.daily?.claimedActivity ?? []);
  const complete = claimed.has(ACTIVITY_TARGET);
  const remaining = context.config.automation.daily.activityRewardPoints.filter((point) => !claimed.has(point));
  context.report.activity = {
    status: complete ? (initiallyComplete ? "already-complete" : "newly-complete") : "incomplete",
    claimed: context.config.automation.daily.activityRewardPoints.filter((point) => claimed.has(point)),
    remaining,
    failedRewards: failedRewards.size
  };
  if (!targetEnabled) {
    context.report.activity.reason = "target-not-configured";
    context.report.actions.push({ type: "activity-target", status: "skipped", point: ACTIVITY_TARGET, reason: "not-configured" });
    return;
  }
  if (!complete) {
    context.report.actions.push({ type: "activity-target", status: "pending", point: ACTIVITY_TARGET, remaining });
  }
  if (Number(state.view.navigation?.activityClaimableCount ?? 0) > 0 && remaining.length === 0) {
    context.report.actions.push({ type: "activity-reward", status: "pending", reason: "unknown-tier" });
  }
}

export async function runPersonalBoss(context) {
  let state = await readBossState(context.api);
  let submissions = 0;
  while (submissions < BOSS_SUBMISSION_LIMIT) {
    const freeBefore = personalBossFreeRemaining(state);
    if (freeBefore === undefined) {
      context.report.actions.push({ type: "personal-boss", status: "stopped", reason: "unknown-free-pool" });
      return;
    }
    if (freeBefore <= 0) {
      context.report.actions.push({ type: "personal-boss", status: "no-free-attempt" });
      return;
    }

    const candidate = await selectBossCandidate(context, state);
    if (!candidate) {
      context.report.actions.push({ type: "personal-boss", status: "stopped", reason: "no-eligible-candidate" });
      return;
    }
    const action = bossAction(candidate, context.options.dryRun ? "planned" : undefined);
    if (context.options.dryRun) {
      context.report.actions.push(action);
      return;
    }

    const bossCountBefore = finiteCounter(state.bootstrap.daily?.bossCount);
    let result;
    let ambiguous = false;
    try {
      result = dataOf(await context.api.post("/api/boss/challenge", candidate.body));
    } catch (error) {
      if (!error.ambiguous) throw error;
      ambiguous = true;
    }
    submissions += 1;
    state = await readBossState(context.api);
    const freeAfter = personalBossFreeRemaining(state);
    const bossCountAfter = finiteCounter(state.bootstrap.daily?.bossCount);
    const outcome = reconcileBossChallenge({ result, ambiguous, freeBefore, freeAfter, bossCountBefore, bossCountAfter });
    context.report.actions.push({ ...action, status: outcome.status });
    if (!outcome.continue) {
      context.report.actions.push({ type: "personal-boss", status: "stopped", reason: outcome.reason });
      return;
    }
  }
  context.report.actions.push({ type: "personal-boss", status: "stopped", reason: "submission-limit", submissions });
}

async function selectBossCandidate(context, state) {
  for (const layer of personalBossPreviewLayers(state.view.bosses, state.equipment)) {
    const previews = [];
    for (const buffKey of layer.buffKeys) {
      const body = { ...layer.body, buffKey };
      try {
        const preview = await bossPreview(context.api, body);
        previews.push({ buffKey, body, preview });
      } catch (error) {
        context.report.warnings ??= [];
        context.report.warnings.push(`boss preview skipped: ${safeError(error)}`);
      }
    }
    const selected = chooseBossPreview(previews, BOSS_MINIMUM_CHANCE);
    if (selected) return { ...layer, ...selected };
  }
  return undefined;
}

async function bossPreview(api, body) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return dataOf(await api.post("/api/boss/preview", body));
    } catch (error) {
      const retriable = !error.status || error.status === 409 || error.status === 429 || error.status >= 500;
      if (!retriable || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 400));
    }
  }
}

function reconcileBossChallenge({ result, ambiguous, freeBefore, freeAfter, bossCountBefore, bossCountAfter }) {
  if (!Number.isFinite(freeAfter) || freeAfter > freeBefore || freeBefore - freeAfter > 1) {
    return { status: "uncertain", continue: false, reason: "free-pool-conflict" };
  }
  const won = result?.battle?.win;
  if (!ambiguous && won === true && freeAfter === freeBefore - 1) return { status: "won", continue: true };
  if (!ambiguous && won === false && freeAfter === freeBefore
    && bossCountAfter !== undefined && bossCountBefore !== undefined && bossCountAfter > bossCountBefore) {
    return { status: "lost-free-returned", continue: true };
  }
  if (ambiguous && freeAfter === freeBefore - 1) return { status: "reconciled-win", continue: true };
  if (ambiguous && freeAfter === freeBefore && bossCountAfter !== undefined && bossCountBefore !== undefined && bossCountAfter > bossCountBefore) {
    return { status: "reconciled-loss", continue: true };
  }
  return { status: "uncertain", continue: false, reason: "challenge-outcome-unknown" };
}

function bossAction(candidate, status) {
  return {
    type: "personal-boss",
    ...(status ? { status } : {}),
    bossKey: candidate.body.bossKey,
    difficulty: candidate.body.difficulty,
    buffKey: candidate.body.buffKey,
    affixKey: candidate.body.affixKey,
    ...(candidate.body.targetSlot ? { targetSlot: candidate.body.targetSlot } : {}),
    chance: Number(candidate.preview.chance),
    rewardMultiplier: candidate.rewardMultiplier,
    costGold: Number(candidate.difficulty.goldCost),
    costMaterial: Number(candidate.difficulty.materialCost)
  };
}

function personalBossFreeRemaining(state) {
  const bootstrap = finiteCounter(state.bootstrap.player?.personalBossAttempts?.freeRemaining);
  const viewValues = (state.view.bosses ?? [])
    .filter((boss) => boss?.type === "personal")
    .map((boss) => finiteCounter(boss.personalAttemptPool?.freeRemaining))
    .filter((value) => value !== undefined);
  const view = viewValues.length > 0 && viewValues.every((value) => value === viewValues[0]) ? viewValues[0] : undefined;
  if (bootstrap !== undefined && view !== undefined && bootstrap !== view) return undefined;
  return bootstrap ?? view;
}

function finiteCounter(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
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

export function nextDailyAction(state, knownActivityPoints, failedRewards = new Set()) {
  const { bootstrap, view, guild } = state;
  const day = bootstrap.daily?.key;
  const signIn = bootstrap.retention?.signIn ?? {};
  if (day && signIn.lastClaimedKey !== day && !(signIn.claimedKeys ?? []).includes(day) && !failedRewards.has(dailyRewardIdentity("sign-in", day))) {
    return { type: "sign-in", path: "/api/retention/sign-in", body: {} };
  }
  const quest = (view.quests ?? []).find((entry) => validRewardKey(entry?.key) && entry.available === true && entry.completed === true && entry.claimed !== true && !failedRewards.has(dailyRewardIdentity("quest-reward", entry.key)));
  if (quest) return { type: "quest-reward", path: "/api/quests/claim", body: { questKey: quest.key }, identity: quest.key };
  const achievement = (view.achievements ?? []).find((entry) => validRewardKey(entry?.key) && entry.unlocked === true && entry.claimed !== true && !failedRewards.has(dailyRewardIdentity("achievement-reward", entry.key)));
  if (achievement) return { type: "achievement-reward", path: "/api/achievements/claim", body: { achievementKey: achievement.key }, identity: achievement.key };
  const codex = (view.codex?.rewards ?? []).find((entry) => validRewardKey(entry?.key) && entry.unlocked === true && entry.claimed !== true && !failedRewards.has(dailyRewardIdentity("codex-reward", entry.key)));
  if (codex) return { type: "codex-reward", path: "/api/codex/claim", body: { rewardKey: codex.key }, identity: codex.key };
  const season = (view.rankingSeason?.rewards ?? []).find((entry) => validRewardKey(entry?.key) && entry.unlocked === true && entry.claimed !== true && !failedRewards.has(dailyRewardIdentity("season-reward", entry.key)));
  if (season) return { type: "season-reward", path: "/api/ranking/season/claim", body: { rewardKey: season.key }, identity: season.key };
  const guildReward = guild?.joined === true && (guild.progressRewards ?? []).find((entry) => {
    return Number.isInteger(entry?.point) && entry.point > 0
      && entry.canClaim === true
      && entry.claimed !== true
      && !failedRewards.has(dailyRewardIdentity("guild-progress-reward", entry.point));
  });
  if (guildReward) return { type: "guild-progress-reward", path: "/api/guild/claim-progress", body: { point: guildReward.point }, point: guildReward.point };
  const claimedActivity = bootstrap.daily?.claimedActivity;
  if (Array.isArray(claimedActivity)) {
    const claimed = new Set(claimedActivity);
    const point = knownActivityPoints.find((candidate) => !claimed.has(candidate) && !failedRewards.has(dailyRewardIdentity("activity-reward", candidate)));
    if (point !== undefined) return { type: "activity-reward", path: "/api/daily/claim", body: { point }, point };
  }
  const claimedMail = new Set(bootstrap.claimedMailRewardIds ?? []);
  const mail = (bootstrap.mails ?? []).find((entry) => validRewardKey(entry?.id) && entry.claimed !== true && !claimedMail.has(entry.id) && hasMailReward(entry.reward) && !failedRewards.has(dailyRewardIdentity("mail-attachment", entry.id)));
  if (mail) return { type: "mail-attachment", path: "/api/mail/claim", body: { mailId: mail.id }, identity: mail.id };
  return undefined;
}

function dailyActionOutcome(state, action) {
  const { bootstrap, view } = state;
  if (action.type === "sign-in") {
    const day = bootstrap.daily?.key;
    const signIn = bootstrap.retention?.signIn;
    if (!day || !signIn || typeof signIn !== "object") return "unknown";
    return signIn.lastClaimedKey === day || (signIn.claimedKeys ?? []).includes(day) ? "claimed" : "pending";
  }
  if (action.type === "quest-reward") return collectionRewardOutcome(view.quests, action.identity, (entry) => entry.available === true && entry.completed === true);
  if (action.type === "achievement-reward") return collectionRewardOutcome(view.achievements, action.identity, (entry) => entry.unlocked === true);
  if (action.type === "codex-reward") return collectionRewardOutcome(view.codex?.rewards, action.identity, (entry) => entry.unlocked === true);
  if (action.type === "season-reward") return collectionRewardOutcome(view.rankingSeason?.rewards, action.identity, (entry) => entry.unlocked === true);
  if (action.type === "guild-progress-reward") {
    if (!Array.isArray(state.guild?.progressRewards)) return "unknown";
    const entry = state.guild.progressRewards.find((candidate) => candidate?.point === action.point);
    return entry?.canClaim === true && entry.claimed !== true ? "pending" : "claimed";
  }
  if (action.type === "activity-reward") {
    if (!Array.isArray(bootstrap.daily?.claimedActivity)) return "unknown";
    return bootstrap.daily.claimedActivity.includes(action.point) ? "claimed" : "pending";
  }
  if (action.type === "mail-attachment") {
    if (!Array.isArray(bootstrap.mails) || !Array.isArray(bootstrap.claimedMailRewardIds)) return "unknown";
    if (bootstrap.claimedMailRewardIds.includes(action.identity)) return "claimed";
    const entry = bootstrap.mails.find((candidate) => candidate?.id === action.identity);
    return entry?.claimed === false ? "pending" : "claimed";
  }
  return "unknown";
}

function collectionRewardOutcome(collection, identity, eligible) {
  if (!Array.isArray(collection)) return "unknown";
  const entry = collection.find((candidate) => candidate?.key === identity);
  return entry && eligible(entry) && entry.claimed !== true ? "pending" : "claimed";
}

function validRewardKey(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function pretendDailyClaimed(state, action) {
  const clone = structuredClone(state);
  if (action.type === "sign-in") clone.bootstrap.retention.signIn.lastClaimedKey = clone.bootstrap.daily.key;
  else if (action.type === "quest-reward") clone.view.quests.find((entry) => entry.key === action.identity).claimed = true;
  else if (action.type === "achievement-reward") clone.view.achievements.find((entry) => entry.key === action.identity).claimed = true;
  else if (action.type === "codex-reward") clone.view.codex.rewards.find((entry) => entry.key === action.identity).claimed = true;
  else if (action.type === "season-reward") clone.view.rankingSeason.rewards.find((entry) => entry.key === action.identity).claimed = true;
  else if (action.type === "guild-progress-reward") clone.guild.progressRewards.find((entry) => entry.point === action.point).claimed = true;
  else if (action.type === "activity-reward") {
    clone.bootstrap.daily.claimedActivity ??= [];
    clone.bootstrap.daily.claimedActivity.push(action.point);
    clone.view.navigation ??= {};
    clone.view.navigation.activityClaimableCount = Math.max(0, Number(clone.view.navigation.activityClaimableCount ?? 0) - 1);
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
  const guildRequest = api.get("/api/guild/view")
    .then((payload) => dataOf(payload))
    .catch((error) => ({ unavailable: true, reason: safeError(error) }));
  const [bootstrap, view, guild] = await Promise.all([
    api.get("/api/client/bootstrap"),
    api.get("/api/client/dynamic-view"),
    guildRequest
  ]);
  return { bootstrap: dataOf(bootstrap), view: dataOf(view), guild };
}

async function readEquipment(api) {
  const data = dataOf(await api.get("/api/equipment/list"));
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.equipment)) return data.equipment;
  throw new Error("equipment list response was malformed");
}

async function readBossState(api) {
  const [bootstrap, view, equipment] = await Promise.all([
    api.get("/api/client/bootstrap"),
    api.get("/api/client/dynamic-view"),
    readEquipment(api)
  ]);
  return {
    bootstrap: dataOf(bootstrap),
    view: dataOf(view),
    equipment
  };
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

function dailyActionIdentity(action, state) {
  if (action.identity !== undefined) return dailyRewardIdentity(action.type, action.identity);
  if (action.point !== undefined) return dailyRewardIdentity(action.type, action.point);
  if (action.type === "sign-in") return dailyRewardIdentity("sign-in", state.bootstrap.daily?.key ?? "unknown");
  return dailyRewardIdentity(action.type);
}

function dailyRewardIdentity(type, identity) {
  return identity === undefined ? type : `${type}:${identity}`;
}

function dailyActionReport(action, status) {
  return {
    type: action.type,
    status,
    ...(action.point !== undefined ? { point: action.point } : {}),
    ...(action.identity !== undefined ? { identity: action.identity } : {})
  };
}

function activityTierClaimed(state, point) {
  return Array.isArray(state.bootstrap.daily?.claimedActivity)
    && state.bootstrap.daily.claimedActivity.includes(point);
}

function activityStateKnown(state) {
  return Array.isArray(state.bootstrap.daily?.claimedActivity);
}

function activityPursuitBlocked(failedRewards, activitySafety) {
  return activitySafety.blocked || failedRewards.has(DAILY_REWARD_LIMIT_IDENTITY);
}

function allowActivityRewardRetry(failedRewards) {
  for (const identity of failedRewards) {
    if (identity.startsWith("activity-reward:")) failedRewards.delete(identity);
  }
}

function safeDecompositionPreview(preview, equipmentIds) {
  if (!Array.isArray(equipmentIds) || equipmentIds.length === 0) return false;
  const expected = new Set(equipmentIds);
  return expected.size === equipmentIds.length
    && Number(preview?.equipmentCount) === equipmentIds.length
    && Array.isArray(preview?.equipmentIds)
    && preview.equipmentIds.length === equipmentIds.length
    && preview.equipmentIds.every((equipmentId) => expected.delete(equipmentId))
    && expected.size === 0;
}

function transientRequestFailure(error) {
  return error?.ambiguous === true
    || !Number.isFinite(Number(error?.status))
    || error.status === 409
    || error.status === 429
    || error.status >= 500;
}

function counterIncreased(before, after) {
  const previous = finiteCounter(before);
  const next = finiteCounter(after);
  return previous !== undefined && next !== undefined && next > previous;
}

function assertNodeVersion() {
  const major = Number(process.versions.node.split(".", 1)[0]);
  if (!Number.isInteger(major) || major < 24) throw new Error("Node.js 24 or newer is required");
}

export function applyDefaults(config) {
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
      daily: {
        activityRewardPoints: automation.daily?.activityRewardPoints ?? KNOWN_ACTIVITY_POINTS,
        marketMaxGold: automation.daily?.marketMaxGold ?? 300,
        decomposition: {
          qualities: (automation.daily?.decomposition?.qualities ?? ["white", "green", "blue"])
            .map((quality) => QUALITY_ALIASES[String(quality).toLowerCase()] ?? quality),
          minLevel: automation.daily?.decomposition?.minLevel,
          maxLevel: automation.daily?.decomposition?.maxLevel,
          protectPremiumAffixes: automation.daily?.decomposition?.protectPremiumAffixes ?? true
        }
      }
    }
  };
}

export function validateConfig(config) {
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
  if (!Array.isArray(points) || points.length === 0 || points.some((point) => !KNOWN_ACTIVITY_POINTS.includes(point)) || new Set(points).size !== points.length) {
    throw new Error(`activityRewardPoints must contain unique known tiers: ${KNOWN_ACTIVITY_POINTS.join(", ")}`);
  }
  const marketMaxGold = config.automation.daily.marketMaxGold;
  if (!Number.isInteger(marketMaxGold) || marketMaxGold < 0) throw new Error("marketMaxGold must be a non-negative integer");
  const decomposition = config.automation.daily.decomposition;
  if (!Array.isArray(decomposition.qualities) || decomposition.qualities.length === 0 || decomposition.qualities.some((quality) => !QUALITY_KEYS.has(quality))) {
    throw new Error("decomposition qualities contain an unknown quality");
  }
  for (const key of ["minLevel", "maxLevel"]) {
    if (decomposition[key] !== undefined && (!Number.isInteger(decomposition[key]) || decomposition[key] < 1)) {
      throw new Error(`decomposition ${key} must be a positive integer`);
    }
  }
  if (decomposition.minLevel !== undefined && decomposition.maxLevel !== undefined && decomposition.minLevel > decomposition.maxLevel) {
    throw new Error("decomposition minLevel must not exceed maxLevel");
  }
  if (typeof decomposition.protectPremiumAffixes !== "boolean") throw new Error("protectPremiumAffixes must be boolean");
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
  if (error instanceof ApiError) {
    let reason = "request rejected";
    if (error.authentication) reason = "authentication rejected";
    else if (error.ambiguous) reason = "outcome uncertain after network failure";
    else if (error.requiredVersion) reason = `client upgrade failed (server requires ${error.requiredVersion})`;
    return `${error.path ?? "request"}: ${reason}`;
  }
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
  console.log(`PlaceGame daily automation\n\nUsage:\n  node placegame-auto.mjs [run|status|idle|daily|arcade|boss] [options]\n\nOptions:\n  --config <path>   Account config (default: .placegame-accounts.local.json)\n  --state <path>    Private Session/action state\n  --log-dir <path>  Redacted JSONL report directory\n  --account <alias> Run one configured account\n  --dry-run         Read state and report planned mutations\n  --json            Print structured output\n  --help            Show this help`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`placegame-auto: ${safeError(error)}`);
    process.exitCode = 1;
  });
}
