import test from "node:test";
import assert from "node:assert/strict";
import { PlaceGameApi } from "../lib/placegame-api.mjs";

test("GET retries a transport failure with required CLI headers", async () => {
  let calls = 0;
  const api = new PlaceGameApi({
    baseUrl: "https://example.invalid",
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.headers["x-placegame-client-version"], "0.2.37");
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

test("GET transport failure remains identifiable after retries", async () => {
  const api = new PlaceGameApi({
    baseUrl: "https://example.invalid",
    fetchImpl: async () => { throw new TypeError("offline"); }
  });

  await assert.rejects(
    api.get("/api/read"),
    (error) => error.transport === true && error.ambiguous === false && error.code === "TypeError"
  );
});

test("server rejection preserves its actionable error detail", async () => {
  const api = new PlaceGameApi({
    baseUrl: "https://example.invalid",
    fetchImpl: async () => Response.json({ ok: false, error: "最多选择 3 个出战技能。" }, { status: 400 })
  });

  await assert.rejects(
    api.post("/api/boss/preview", {}),
    (error) => error.status === 400 && error.detail === "最多选择 3 个出战技能。"
  );
});

test("426 response upgrades the client version and retries the rejected request", async () => {
  const versions = [];
  const api = new PlaceGameApi({
    baseUrl: "https://example.invalid",
    fetchImpl: async (_url, options) => {
      versions.push(options.headers["x-placegame-client-version"]);
      assert.equal(options.method, "POST");
      assert.equal(options.body, '{"username":"u","password":"p"}');
      if (versions.length === 1) {
        return new Response(JSON.stringify({
          ok: false,
          error: "Current client is too old. Upgrade to 0.2.38 to continue."
        }), {
          status: 426,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ ok: true, data: { sessionToken: "session" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const result = await api.post("/api/auth/login", { username: "u", password: "p" });

  assert.deepEqual(versions, ["0.2.37", "0.2.38"]);
  assert.equal(api.version, "0.2.38");
  assert.equal(result.data.sessionToken, "session");
});

test("426 response without a version is not retried", async () => {
  let calls = 0;
  const api = new PlaceGameApi({
    baseUrl: "https://example.invalid",
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: false, error: "Upgrade required" }), {
        status: 426,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await assert.rejects(api.get("/api/read"), (error) => error.status === 426 && error.requiredVersion === undefined);
  assert.equal(calls, 1);
});

test("client version negotiation retries at most once", async () => {
  const versions = [];
  const api = new PlaceGameApi({
    baseUrl: "https://example.invalid",
    fetchImpl: async (_url, options) => {
      versions.push(options.headers["x-placegame-client-version"]);
      const requiredVersion = versions.length === 1 ? "0.2.38" : "0.2.39";
      return new Response(JSON.stringify({ ok: false, error: `Upgrade to ${requiredVersion}` }), {
        status: 426,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await assert.rejects(api.get("/api/read"), (error) => error.status === 426 && error.requiredVersion === "0.2.39");
  assert.deepEqual(versions, ["0.2.37", "0.2.38"]);
});

test("concurrent 426 responses each retry after the shared version changes", async () => {
  const versions = [];
  let initialCalls = 0;
  const { promise: initialGate, resolve: releaseInitial } = Promise.withResolvers();
  const api = new PlaceGameApi({
    baseUrl: "https://example.invalid",
    fetchImpl: async (_url, options) => {
      const version = options.headers["x-placegame-client-version"];
      versions.push(version);
      if (version === "0.2.37") {
        initialCalls += 1;
        if (initialCalls === 2) releaseInitial();
        await initialGate;
        return Response.json({ ok: false, error: "Upgrade to 0.2.38" }, { status: 426 });
      }
      return Response.json({ ok: true, data: { version } });
    }
  });

  const results = await Promise.all([api.get("/api/first"), api.get("/api/second")]);

  assert.deepEqual(versions, ["0.2.37", "0.2.37", "0.2.38", "0.2.38"]);
  assert.deepEqual(results.map((result) => result.data.version), ["0.2.38", "0.2.38"]);
});
