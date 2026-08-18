import test from "node:test";
import assert from "node:assert/strict";
import { runWorldBossScheduler } from "../scripts/world-boss-scheduler.mjs";

test("world boss scheduler logs timezone context and recovers the current Beijing window once", async () => {
  const controller = new AbortController();
  const events = [];
  const logs = [];

  await runWorldBossScheduler({
    now: () => new Date("2026-08-18T02:30:00.000Z"),
    invoke: async (event) => {
      events.push(event.id);
      controller.abort();
      return 0;
    },
    sleep: async () => assert.fail("recovery abort should stop before sleeping"),
    log: (line) => logs.push(line),
    signal: controller.signal
  });

  assert.deepEqual(events, ["2026-08-18@10:00"]);
  assert.match(logs[0], /"hostTimeZone":"[^"]+"/);
  assert.match(logs[0], /"hostUtcOffset":"[+-]\d{2}:\d{2}"/);
  assert.match(logs[0], /"beijingTimeZone":"Asia\/Shanghai"/);
  assert.equal(logs.filter((line) => line.includes("trigger")).length, 1);
});
