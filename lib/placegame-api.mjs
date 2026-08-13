export class ApiError extends Error {
  constructor(message, { status, path, code, ambiguous = false } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.path = path;
    this.code = code;
    this.ambiguous = ambiguous;
  }

  get authentication() {
    return this.status === 401 || this.status === 403;
  }
}

export class PlaceGameApi {
  constructor({ baseUrl, version = "0.2.36", timeoutMs = 25_000, fetchImpl = globalThis.fetch }) {
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
        ambiguous: method !== "GET"
      });
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ApiError("server returned invalid JSON", { status: response.status, path, ambiguous: method !== "GET" });
    }
    if (!response.ok || payload?.ok === false) {
      throw new ApiError(`server rejected ${method} ${path}`, {
        status: response.status,
        path,
        code: payload?.code,
        ambiguous: false
      });
    }
    return payload;
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
