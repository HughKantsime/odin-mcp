/**
 * ODIN HTTP client for the v2 MCP tool surface.
 *
 * Reads ODIN_BASE_URL + ODIN_API_KEY from env. Each tool invocation
 * that needs a live ODIN call goes through `odinRequest()` which
 * wraps fetch with:
 *   - bounded timeout (5s default, per-tool override via AbortSignal)
 *   - explicit Idempotency-Key header on mutating calls (caller
 *     supplies it so retries with the same semantic input dedupe)
 *   - optional X-Dry-Run: true header propagated when the tool input
 *     contains `dry_run: true`
 *   - error envelope handling: ODIN returns
 *     {error: {code, detail, retriable}} on 4xx/5xx — we surface
 *     `code` and `detail` as a structured MCP error
 *   - `X-Idempotent-Replay: true` response header detection so the
 *     caller can mark replayed responses in the tool result
 *
 * Companion Phase 1 backend primitives (2026-04-15):
 *   - Idempotency middleware (claim-before-execute, CAS, auth
 *     fingerprint, uncacheable_success, media_type preservation)
 *   - Dry-run header infrastructure
 *   - OdinError envelope (dual-shape: top-level `detail` for legacy
 *     clients + `error.{code, detail, retriable}` for agents)
 *   - require_any_scope() dep with agent:read / agent:write scopes
 *   - ODIN_ITAR_MODE=1 hard-lock on outbound egress
 */

import { randomUUID } from "node:crypto";

export interface OdinClientConfig {
  baseUrl: string;
  apiKey: string;
  defaultTimeoutMs: number;
}

export interface OdinErrorEnvelope {
  code: string;
  detail: string;
  retriable: boolean;
  [key: string]: unknown;
}

export class OdinApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly retriable: boolean;
  readonly extra: Record<string, unknown>;

  constructor(status: number, envelope: OdinErrorEnvelope) {
    super(`[${envelope.code}] ${envelope.detail}`);
    this.name = "OdinApiError";
    this.status = status;
    this.code = envelope.code;
    this.detail = envelope.detail;
    this.retriable = envelope.retriable;
    // Preserve any custom extra fields (quota usage counts, etc.)
    const { code: _c, detail: _d, retriable: _r, ...rest } = envelope;
    this.extra = rest;
  }
}

export interface OdinRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  dryRun?: boolean;
  timeoutMs?: number;
}

export interface OdinResponse<T = unknown> {
  status: number;
  body: T;
  idempotentReplay: boolean;
}

/**
 * Read client config from env. Throws a clear error if unset so the
 * tool layer can surface a "configure ODIN_BASE_URL + ODIN_API_KEY"
 * hint rather than a generic fetch failure.
 *
 * Reference.* tools don't need a live ODIN — they bypass this
 * constructor entirely.
 */
export function loadClientFromEnv(): OdinClientConfig {
  const baseUrl = (process.env.ODIN_BASE_URL ?? "").replace(/\/+$/, "");
  const apiKey = process.env.ODIN_API_KEY ?? "";
  if (!baseUrl) {
    throw new Error(
      "ODIN_BASE_URL is not set. The live-ODIN tool surface requires " +
        "a reachable ODIN instance. Set ODIN_BASE_URL=http://localhost:8000 " +
        "(or wherever your ODIN backend runs). Reference.* tools work " +
        "without this and don't require a live backend.",
    );
  }
  if (!apiKey) {
    throw new Error(
      "ODIN_API_KEY is not set. Create a per-user token in ODIN " +
        "(Settings → API Tokens) with scope 'agent:read' or 'agent:write' " +
        "and export it as ODIN_API_KEY. The global API_KEY env on the " +
        "backend is NOT used for scope checks — mint a scoped token.",
    );
  }
  return {
    baseUrl,
    apiKey,
    defaultTimeoutMs: 5_000,
  };
}

function buildQueryString(query?: Record<string, string | number | boolean | undefined>): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

/**
 * Execute one ODIN HTTP request.
 *
 * Callers: use `odinGet` / `odinPost` / `odinPatch` / `odinDelete`
 * helpers below for ergonomics. This function is the raw layer.
 *
 * Contract:
 *   - 2xx → returns {status, body, idempotentReplay}
 *   - 4xx/5xx with envelope → throws OdinApiError (agent layer
 *     branches on .code)
 *   - 4xx/5xx without envelope → throws a generic Error with the
 *     status code in the message
 *   - network / timeout → throws a generic Error with "timeout" or
 *     "network" in the message
 */
export async function odinRequest<T = unknown>(
  cfg: OdinClientConfig,
  path: string,
  opts: OdinRequestOptions = {},
): Promise<OdinResponse<T>> {
  const method = opts.method ?? "GET";
  const url = `${cfg.baseUrl}${path.startsWith("/") ? path : `/${path}`}${buildQueryString(opts.query)}`;

  const headers: Record<string, string> = {
    "X-API-Key": cfg.apiKey,
    Accept: "application/json",
  };

  let bodyPayload: string | undefined;
  if (opts.body !== undefined) {
    bodyPayload = JSON.stringify(opts.body);
    headers["Content-Type"] = "application/json";
    // Explicit Content-Length — Phase 1 middleware requires a bounded
    // length when Idempotency-Key is present.
    headers["Content-Length"] = String(Buffer.byteLength(bodyPayload, "utf8"));
  } else if (method !== "GET") {
    // Empty-body mutators still need a valid Content-Length so the
    // backend idempotency middleware doesn't 411.
    headers["Content-Length"] = "0";
  }

  const isMutating = method !== "GET";
  if (isMutating) {
    headers["Idempotency-Key"] = opts.idempotencyKey ?? randomUUID();
  }
  if (opts.dryRun) {
    headers["X-Dry-Run"] = "true";
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? cfg.defaultTimeoutMs;
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: bodyPayload,
      signal: controller.signal,
    });
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    if (controller.signal.aborted) {
      throw new Error(`ODIN request timeout after ${timeoutMs}ms: ${method} ${path}`);
    }
    throw new Error(`ODIN network error: ${method} ${path}: ${msg}`);
  } finally {
    clearTimeout(timeoutHandle);
  }

  const idempotentReplay = resp.headers.get("X-Idempotent-Replay") === "true";

  const text = await resp.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { detail: text };
  }

  if (!resp.ok) {
    // ODIN returns the dual-shape envelope; prefer `error` for
    // machine-readable handling.
    const envelope = (parsed as { error?: OdinErrorEnvelope })?.error;
    if (envelope && typeof envelope.code === "string") {
      throw new OdinApiError(resp.status, envelope);
    }
    const detail =
      (parsed as { detail?: string })?.detail ??
      `HTTP ${resp.status}`;
    throw new Error(`ODIN error ${resp.status} on ${method} ${path}: ${detail}`);
  }

  return {
    status: resp.status,
    body: parsed as T,
    idempotentReplay,
  };
}

// ---------------------------------------------------------------------
// Convenience helpers per HTTP verb.
// ---------------------------------------------------------------------

export async function odinGet<T = unknown>(
  cfg: OdinClientConfig,
  path: string,
  opts: Omit<OdinRequestOptions, "method" | "body"> = {},
): Promise<OdinResponse<T>> {
  return odinRequest<T>(cfg, path, { ...opts, method: "GET" });
}

export async function odinPost<T = unknown>(
  cfg: OdinClientConfig,
  path: string,
  opts: Omit<OdinRequestOptions, "method"> = {},
): Promise<OdinResponse<T>> {
  return odinRequest<T>(cfg, path, { ...opts, method: "POST" });
}

export async function odinPatch<T = unknown>(
  cfg: OdinClientConfig,
  path: string,
  opts: Omit<OdinRequestOptions, "method"> = {},
): Promise<OdinResponse<T>> {
  return odinRequest<T>(cfg, path, { ...opts, method: "PATCH" });
}

export async function odinDelete<T = unknown>(
  cfg: OdinClientConfig,
  path: string,
  opts: Omit<OdinRequestOptions, "method"> = {},
): Promise<OdinResponse<T>> {
  return odinRequest<T>(cfg, path, { ...opts, method: "DELETE" });
}
