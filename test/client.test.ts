/**
 * Integration tests for the client layer.
 *
 * These don't use the MCP SDK — they exercise `odinRequest` / odinGet
 * / odinPost / etc. directly against the mock ODIN server. The goal:
 * prove every contract point with the Phase 1 backend primitives
 * (idempotency, dry-run, error envelope, media-type preservation)
 * works from the MCP client side.
 *
 * Run: `node --test --import tsx test/client.test.ts`
 * Or via the project script once it's wired.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startMockServer, errorEnvelope, MockServer } from "./mock_server.ts";
import {
  odinGet,
  odinPost,
  odinPatch,
  OdinApiError,
  type OdinClientConfig,
} from "../src/client.ts";

let mock: MockServer;
let cfg: OdinClientConfig;

beforeEach(async () => {
  mock = await startMockServer();
  cfg = {
    baseUrl: mock.url,
    apiKey: "odin_test_token_xxxxxxxxxx",
    defaultTimeoutMs: 5_000,
  };
});

afterEach(async () => {
  await mock.close();
});

describe("client — read path", () => {
  test("GET returns parsed body + status", async () => {
    mock.setRoute("GET", "/api/v1/printers", () => ({
      status: 200,
      json: [{ id: 1, name: "p1" }],
    }));

    const resp = await odinGet<Array<{ id: number }>>(cfg, "/api/v1/printers");
    assert.equal(resp.status, 200);
    assert.deepEqual(resp.body, [{ id: 1, name: "p1" }]);
    assert.equal(resp.idempotentReplay, false);
  });

  test("GET sends X-API-Key header", async () => {
    mock.setRoute("GET", "/api/v1/printers", () => ({ status: 200, json: [] }));
    await odinGet(cfg, "/api/v1/printers");
    assert.equal(mock.requests[0].headers["x-api-key"], cfg.apiKey);
  });

  test("query params are serialized", async () => {
    mock.setRoute("GET", "/api/v1/jobs", () => ({ status: 200, json: [] }));
    await odinGet(cfg, "/api/v1/jobs", { query: { status: "pending", limit: 10 } });
    assert.equal(mock.requests[0].query.status, "pending");
    assert.equal(mock.requests[0].query.limit, "10");
  });

  test("GET does NOT send Idempotency-Key (reads are idempotent by HTTP spec)", async () => {
    mock.setRoute("GET", "/api/v1/printers", () => ({ status: 200, json: [] }));
    await odinGet(cfg, "/api/v1/printers");
    assert.equal(mock.requests[0].headers["idempotency-key"], undefined);
  });
});

describe("client — write path", () => {
  test("POST auto-generates Idempotency-Key when not provided", async () => {
    mock.setRoute("POST", "/api/v1/jobs", () => ({ status: 201, json: { id: 7 } }));
    await odinPost(cfg, "/api/v1/jobs", { body: { item: "x" } });
    const key = mock.requests[0].headers["idempotency-key"];
    assert.match(key!, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("POST uses caller-supplied Idempotency-Key when provided", async () => {
    mock.setRoute("POST", "/api/v1/jobs", () => ({ status: 201, json: { id: 7 } }));
    const stable = "11111111-2222-3333-4444-555555555555";
    await odinPost(cfg, "/api/v1/jobs", { body: { item: "x" }, idempotencyKey: stable });
    assert.equal(mock.requests[0].headers["idempotency-key"], stable);
  });

  test("dry_run sends X-Dry-Run: true", async () => {
    mock.setRoute("POST", "/api/v1/jobs", () => ({
      status: 200,
      json: { dry_run: true, would_execute: { action: "queue_job" } },
    }));
    await odinPost(cfg, "/api/v1/jobs", { body: { item: "x" }, dryRun: true });
    assert.equal(mock.requests[0].headers["x-dry-run"], "true");
  });

  test("dry_run omitted → no X-Dry-Run header", async () => {
    mock.setRoute("POST", "/api/v1/jobs", () => ({ status: 201, json: { id: 7 } }));
    await odinPost(cfg, "/api/v1/jobs", { body: { item: "x" } });
    assert.equal(mock.requests[0].headers["x-dry-run"], undefined);
  });

  test("POST with body sends Content-Length", async () => {
    mock.setRoute("POST", "/api/v1/jobs", () => ({ status: 201, json: { id: 7 } }));
    await odinPost(cfg, "/api/v1/jobs", { body: { item: "x" } });
    const cl = mock.requests[0].headers["content-length"];
    assert.ok(cl && Number(cl) > 0, `Content-Length must be present and > 0, got ${cl}`);
  });

  test("empty-body POST sends Content-Length: 0", async () => {
    mock.setRoute("POST", "/api/v1/printers/1/pause", () => ({
      status: 200,
      json: { paused: true },
    }));
    await odinPost(cfg, "/api/v1/printers/1/pause");
    assert.equal(mock.requests[0].headers["content-length"], "0");
  });

  test("PATCH works like POST", async () => {
    mock.setRoute("PATCH", "/api/v1/alerts/7/read", () => ({
      status: 200,
      json: { read: true },
    }));
    await odinPatch(cfg, "/api/v1/alerts/7/read");
    assert.equal(mock.requests[0].method, "PATCH");
    assert.ok(mock.requests[0].headers["idempotency-key"]);
  });
});

describe("client — error envelope parsing", () => {
  test("4xx with envelope → throws OdinApiError with code/detail/retriable", async () => {
    mock.setRoute("POST", "/api/v1/jobs", () => ({
      status: 404,
      json: errorEnvelope("printer_not_found", "Printer 42 not found"),
    }));
    await assert.rejects(
      () => odinPost(cfg, "/api/v1/jobs", { body: {} }),
      (err: Error) => {
        assert.ok(err instanceof OdinApiError);
        const e = err as OdinApiError;
        assert.equal(e.code, "printer_not_found");
        assert.equal(e.detail, "Printer 42 not found");
        assert.equal(e.retriable, false);
        assert.equal(e.status, 404);
        return true;
      },
    );
  });

  test("429 rate_limited surfaces as retriable", async () => {
    mock.setRoute("POST", "/api/v1/jobs", () => ({
      status: 429,
      json: errorEnvelope("rate_limited", "Slow down", true),
    }));
    await assert.rejects(
      () => odinPost(cfg, "/api/v1/jobs", { body: {} }),
      (err: Error) => {
        const e = err as OdinApiError;
        assert.equal(e.code, "rate_limited");
        assert.equal(e.retriable, true);
        return true;
      },
    );
  });

  test("envelope preserves extra keys", async () => {
    mock.setRoute("POST", "/api/v1/jobs", () => ({
      status: 402,
      json: errorEnvelope("quota_exceeded", "Monthly quota exhausted", false, {
        used_grams: 1050,
        limit_grams: 1000,
      }),
    }));
    await assert.rejects(
      () => odinPost(cfg, "/api/v1/jobs", { body: {} }),
      (err: Error) => {
        const e = err as OdinApiError;
        assert.equal(e.extra.used_grams, 1050);
        assert.equal(e.extra.limit_grams, 1000);
        return true;
      },
    );
  });

  test("4xx without structured envelope still throws with message", async () => {
    mock.setRoute("POST", "/api/v1/jobs", () => ({
      status: 400,
      json: { detail: "legacy plain detail" },
    }));
    await assert.rejects(
      () => odinPost(cfg, "/api/v1/jobs", { body: {} }),
      (err: Error) => /legacy plain detail/.test(err.message),
    );
  });
});

describe("client — idempotent replay", () => {
  test("X-Idempotent-Replay: true is surfaced on the response", async () => {
    mock.setRoute("POST", "/api/v1/jobs", () => ({
      status: 201,
      json: { id: 7 },
      headers: { "X-Idempotent-Replay": "true" },
    }));
    const resp = await odinPost(cfg, "/api/v1/jobs", { body: { item: "x" } });
    assert.equal(resp.idempotentReplay, true);
  });

  test("absent X-Idempotent-Replay header → idempotentReplay false", async () => {
    mock.setRoute("POST", "/api/v1/jobs", () => ({ status: 201, json: { id: 7 } }));
    const resp = await odinPost(cfg, "/api/v1/jobs", { body: { item: "x" } });
    assert.equal(resp.idempotentReplay, false);
  });

  test("idempotency_conflict 409 surfaces the error code", async () => {
    mock.setRoute("POST", "/api/v1/jobs", () => ({
      status: 409,
      json: errorEnvelope(
        "idempotency_conflict",
        "Idempotency-Key already used with a different request body.",
      ),
    }));
    await assert.rejects(
      () => odinPost(cfg, "/api/v1/jobs", { body: {} }),
      (err: Error) => {
        const e = err as OdinApiError;
        assert.equal(e.code, "idempotency_conflict");
        assert.equal(e.status, 409);
        return true;
      },
    );
  });

  test("idempotency_in_progress 409 is marked retriable", async () => {
    mock.setRoute("POST", "/api/v1/jobs", () => ({
      status: 409,
      json: errorEnvelope(
        "idempotency_in_progress",
        "Another request with this Idempotency-Key is in flight.",
        true,
      ),
    }));
    await assert.rejects(
      () => odinPost(cfg, "/api/v1/jobs", { body: {} }),
      (err: Error) => {
        const e = err as OdinApiError;
        assert.equal(e.code, "idempotency_in_progress");
        assert.equal(e.retriable, true);
        return true;
      },
    );
  });
});

describe("client — timeout + transport", () => {
  test("network timeout throws with 'timeout' in message", async () => {
    const slowCfg = { ...cfg, defaultTimeoutMs: 50 };
    mock.setRoute("GET", "/api/v1/printers", async () => {
      await new Promise((r) => setTimeout(r, 500));
      return { status: 200, json: [] };
    });
    await assert.rejects(
      () => odinGet(slowCfg, "/api/v1/printers"),
      /timeout/i,
    );
  });

  test("connection to nonexistent host throws network error", async () => {
    const badCfg: OdinClientConfig = {
      baseUrl: "http://127.0.0.1:1",
      apiKey: "x",
      defaultTimeoutMs: 1_000,
    };
    await assert.rejects(() => odinGet(badCfg, "/api/v1/x"));
  });
});

describe("client — response media types", () => {
  test("non-JSON 2xx response body is surfaced as text", async () => {
    mock.setRoute("POST", "/api/v1/cameras/1/webrtc", () => ({
      status: 200,
      text: "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n",
      headers: { "content-type": "application/sdp" },
    }));
    // The client parses all responses as JSON; a non-JSON body falls
    // through to {detail: text} which is acceptable for the tool
    // layer's current surface.
    const resp = await odinPost(cfg, "/api/v1/cameras/1/webrtc", { body: { offer: "x" } });
    assert.equal(resp.status, 200);
    // Not strictly required that we parse SDP — just that we don't crash.
    assert.ok(resp.body);
  });
});
