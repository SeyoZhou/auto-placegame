#!/usr/bin/env node

import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beijingWorldBossEvent, nextBeijingWorldBossStart } from "../lib/placegame-policy.mjs";
import { detectWorldBossTimeContext, main } from "../placegame-auto.mjs";

export async function runWorldBossScheduler({
  now = () => new Date(),
  invoke = () => main(["world-boss"]),
  sleep = sleepUntil,
  log = console.log,
  signal
} = {}) {
  const started = now();
  const context = detectWorldBossTimeContext(started);
  log(`[world-boss-scheduler] startup ${JSON.stringify(context)}`);

  const recoveryEvent = beijingWorldBossEvent(started);
  if (recoveryEvent && !signal?.aborted) await invokeSafely(recoveryEvent, invoke, log);

  while (!signal?.aborted) {
    const target = nextBeijingWorldBossStart(now());
    log(`[world-boss-scheduler] next ${target.toISOString()} (${beijingWorldBossEvent(target).id})`);
    await sleep(target, { now, signal });
    if (signal?.aborted) break;
    const current = now();
    if (current.getTime() < target.getTime()) continue;
    const event = beijingWorldBossEvent(current);
    if (event) await invokeSafely(event, invoke, log);
  }
}

async function invokeSafely(event, invoke, log) {
  log(`[world-boss-scheduler] trigger ${event.id}`);
  try {
    const code = await invoke(event);
    if (code) log(`[world-boss-scheduler] ${event.id} finished with exit code ${code}`);
  } catch (error) {
    log(`[world-boss-scheduler] ${event.id} failed: ${safeMessage(error)}`);
  }
}

export function sleepUntil(target, { now = () => new Date(), signal } = {}) {
  const delay = Math.max(0, target.getTime() - now().getTime());
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delay);
    if (signal?.aborted) finish();
    else signal?.addEventListener("abort", finish, { once: true });
  });
}

function safeMessage(error) {
  return String(error?.message ?? "unknown error").replace(/\s+/g, " ").trim().slice(0, 240);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  runWorldBossScheduler({ signal: controller.signal }).catch((error) => {
    console.error(`world-boss-scheduler: ${safeMessage(error)}`);
    process.exitCode = 1;
  });
}
