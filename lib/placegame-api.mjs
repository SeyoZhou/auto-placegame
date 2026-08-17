export class ApiError extends Error {
  constructor(message, { status, path, code, detail, requiredVersion, transport = false, ambiguous = false } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.path = path;
    this.code = code;
    this.detail = detail;
    this.requiredVersion = requiredVersion;
    this.transport = transport;
    this.ambiguous = ambiguous;
  }

  get authentication() {
    return this.status === 401 || this.status === 403;
  }
}

const DEFAULT_CLIENT_VERSION = "0.2.37";

export class PlaceGameApi {
  constructor({ baseUrl, version = DEFAULT_CLIENT_VERSION, timeoutMs = 25_000, fetchImpl = globalThis.fetch }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.version = version;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.session = undefined;
  }

  setSession(session) {
    this.session = session || undefined;
  }

  async get(path, { attempts = 2 } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.request(path);
      } catch (error) {
        lastError = error;
        if (error.authentication || error.status || attempt === attempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 400));
      }
    }
    throw lastError;
  }

  post(path, body = {}) {
    return this.request(path, { method: "POST", body });
  }

  async request(path, { method = "GET", body } = {}) {
    let negotiatedVersion = false;
    while (true) {
      let response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            "content-type": "application/json",
            "x-placegame-client-version": this.version,
            "x-placegame-client-platform": "cli",
            "x-placegame-response-state": "full",
            ...(this.session ? { authorization: `Bearer ${this.session}` } : {})
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs)
        });
      } catch (error) {
        throw new ApiError("network request did not complete", {
          path,
          code: error?.name,
          transport: true,
          ambiguous: method !== "GET"
        });
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new ApiError("server returned invalid JSON", { status: response.status, path, ambiguous: method !== "GET" });
      }
      if (response.ok && payload?.ok !== false) return payload;

      const requiredVersion = response.status === 426 ? requiredClientVersion(payload) : undefined;
      if (!negotiatedVersion && requiredVersion) {
        if (requiredVersion !== this.version) this.version = requiredVersion;
        negotiatedVersion = true;
        continue;
      }
      throw new ApiError(`server rejected ${method} ${path}`, {
        status: response.status,
        path,
        code: payload?.code,
        detail: responseDetail(payload),
        requiredVersion,
        ambiguous: false
      });
    }
  }
}

export function dataOf(payload) {
  return payload?.data?.result ?? payload?.data;
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("server must use HTTP or HTTPS");
  return url.toString().replace(/\/$/, "");
}

function requiredClientVersion(payload) {
  const fields = ["requiredVersion", "minimumVersion", "minVersion", "error", "message"];
  for (const scope of [payload, payload?.data]) {
    for (const field of fields) {
      const candidate = scope?.[field];
      if (typeof candidate !== "string") continue;
      const match = candidate.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/);
      if (match) return match[0];
    }
  }
  return undefined;
}

function responseDetail(payload) {
  for (const scope of [payload, payload?.data]) {
    for (const field of ["error", "message", "reason"]) {
      const candidate = scope?.[field];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
      if (typeof candidate?.message === "string" && candidate.message.trim()) return candidate.message.trim();
    }
  }
  return undefined;
}
