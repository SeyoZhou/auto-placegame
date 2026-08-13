import test from "node:test";
import assert from "node:assert/strict";
import { PlaceGameApi } from "../lib/placegame-api.mjs";

test("GET retries a transport failure with required CLI headers", async () => {
  let calls = 0;
  const api = new PlaceGameApi({
    baseUrl: "https://example.invalid",
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.headers["x-placegame-client-version"], "0.2.36");
      assert.equal(options.headers["x-placegame-client-platform"], "cli");
      assert.equal(options.headers["x-placegame-response-state"], "full");
      assert.equal(options.headers.authorization, "Bearer session-value");
      if (calls === 1) throw new TypeError("temporary network failure");
      return new Response(JSON.stringify({ ok: true, data: { value: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  api.setSession("session-value");
  const result = await api.get("/api/read");
  assert.equal(result.data.value, 1);
  assert.equal(calls, 2);
});

test("POST transport failure is ambiguous and never retried", async () => {
  let calls = 0;
  const api = new PlaceGameApi({
    baseUrl: "https://example.invalid",
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError("connection closed");
    }
  });
  await assert.rejects(
    api.post("/api/mutate", { value: 1 }),
    (error) => error.ambiguous === true && error.path === "/api/mutate"
  );
  assert.equal(calls, 1);
});
