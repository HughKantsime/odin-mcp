/**
 * Minimal ODIN backend mock for MCP integration tests.
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

import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { AddressInfo } from "node:net";

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

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function normalizeHeaders(raw: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

export async function startMockServer(): Promise<MockServer> {
  const routes = new Map<string, RouteHandler>();
  const requests: RecordedRequest[] = [];

  const keyFor = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

  // Default handler for the version-sniff endpoint. Returns 1.9.0 so
  // the client's dry_run safety gate (v2.1.0) is satisfied by default.
  // Individual tests can override via setRoute to simulate pre-1.9.0
  // backends.
  routes.set(keyFor("GET", "/api/v1/version"), () => ({
    status: 200,
    json: { version: "1.9.0" },
  }));

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const rawBody = await readRequestBody(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      query[k] = v;
    });
    let parsedBody: unknown = undefined;
    const ct = String(req.headers["content-type"] ?? "").toLowerCase();
    if (ct.includes("application/json") && rawBody) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = undefined;
      }
    }

    const recorded: RecordedRequest = {
      method: (req.method ?? "GET").toUpperCase(),
      path: url.pathname,
      query,
      headers: normalizeHeaders(req.headers),
      body: parsedBody,
      rawBody,
    };
    requests.push(recorded);

    const handler = routes.get(keyFor(recorded.method, recorded.path));
    if (!handler) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          detail: `No mock route for ${recorded.method} ${recorded.path}`,
          error: {
            code: "not_found",
            detail: `No mock route for ${recorded.method} ${recorded.path}`,
            retriable: false,
          },
        }),
      );
      return;
    }

    try {
      const result = await handler(recorded);
      res.statusCode = result.status;
      for (const [hk, hv] of Object.entries(result.headers ?? {})) {
        res.setHeader(hk, hv);
      }
      if ("json" in result) {
        if (!res.getHeader("content-type")) {
          res.setHeader("content-type", "application/json");
        }
        res.end(JSON.stringify(result.json));
      } else {
        if (!res.getHeader("content-type")) {
          res.setHeader("content-type", "text/plain");
        }
        res.end(result.text);
      }
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          detail: `mock handler error: ${(err as Error).message}`,
          error: {
            code: "internal_error",
            detail: `mock handler error: ${(err as Error).message}`,
            retriable: true,
          },
        }),
      );
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

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
        json: { version: "1.9.0" },
      }));
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
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
