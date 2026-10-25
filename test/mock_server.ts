/**
 * In-process ODIN HTTP mock (no listening sockets) for MCP integration tests.
 *
 * Goals:
 *   - Deterministic: every request records a full trace so tests
 *     can assert "the tool actually called /api/v1/jobs with the
 *     expected payload + Idempotency-Key + X-Dry-Run".
 *   - Controllable: tests inject route handlers that return pre-
 *     canned responses (normal 2xx, 409 envelopes, 500s).
 *   - Envelope-aware: helpers produce the dual-shape error body
 *     the real backend returns so client.ts error parsing is
 *     exercised end-to-end.
 */

export interface RecordedRequest {
  method: string;
  path: string; // URL.pathname
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown; // parsed JSON when content-type is json
  rawBody: string;
}

export type MockResponse =
  | { status: number; json: unknown; headers?: Record<string, string> }
  | { status: number; text: string; headers?: Record<string, string> };

export type RouteHandler = (req: RecordedRequest) => MockResponse | Promise<MockResponse>;

export interface MockServer {
  url: string;
  close: () => Promise<void>;
  setRoute: (method: string, path: string, handler: RouteHandler) => void;
  requests: RecordedRequest[];
  reset: () => void;
}

let nextServer = 0;

export async function startMockServer(): Promise<MockServer> {
  const routes = new Map<string, RouteHandler>();
  const requests: RecordedRequest[] = [];

  const keyFor = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

  // Default handler for the version-sniff endpoint. Returns 2.0.13 so
  // the client's dry_run safety gate (v2.1.0) is satisfied by default.
  // Individual tests can override via setRoute to simulate pre-1.9.0
  // backends.
  routes.set(keyFor("GET", "/api/v1/version"), () => ({
    status: 200,
    json: { version: "2.0.13" },
  }));

  const url = `http://odin-mock-${++nextServer}.invalid`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const target = new URL(String(input));
    if (target.origin !== url) return originalFetch(input, init);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const rawBody = String(init?.body ?? "");
    const query = Object.fromEntries(target.searchParams.entries());
    let body: unknown;
    if (rawBody && headers["content-type"]?.includes("application/json")) body = JSON.parse(rawBody);
    const recorded: RecordedRequest = {
      method: init?.method ?? "GET", path: target.pathname, query, headers, body, rawBody,
    };
    requests.push(recorded);
    const handler = routes.get(keyFor(recorded.method, recorded.path));
    const response = async () => {
      const result = handler ? await handler(recorded) : {
        status: 404, json: errorEnvelope("not_found", `No mock route for ${recorded.method} ${recorded.path}`),
      };
      return new Response("json" in result ? JSON.stringify(result.json) : result.text, {
        status: result.status,
        headers: { "content-type": "json" in result ? "application/json" : "text/plain", ...result.headers },
      });
    };
    const signal = init?.signal;
    if (!signal) return response();
    signal.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      response().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  };

  return {
    url,
    requests,
    setRoute: (method, path, handler) => {
      routes.set(keyFor(method, path), handler);
    },
    reset: () => {
      routes.clear();
      requests.length = 0;
      // Re-install the default version-sniff handler after reset so the
      // client's dry_run safety gate keeps working. Individual tests
      // can still override after calling reset().
      routes.set(keyFor("GET", "/api/v1/version"), () => ({
        status: 200,
        json: { version: "2.0.13" },
      }));
    },
    close: async () => { globalThis.fetch = originalFetch; },
  };
}

// -----------------------------------------------------------------------
// Envelope helpers — produce the dual-shape body the real backend emits.
// -----------------------------------------------------------------------

export function errorEnvelope(code: string, detail: string, retriable = false, extra: Record<string, unknown> = {}) {
  return {
    detail,
    error: {
      code,
      detail,
      retriable,
      ...extra,
    },
  };
}
