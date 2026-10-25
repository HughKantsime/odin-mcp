import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadClientFromEnv } from "../src/client.ts";
import { z } from "zod/v4";
import { registerReadTools } from "../src/tools/read_tools.ts";
import { registerWriteTools } from "../src/tools/write_tools.ts";
import { startMockServer, type MockServer } from "./mock_server.ts";

type Result = { content: { text: string }[]; isError?: boolean };
type Tool = { schema: Record<string, z.ZodType>; run: (args: any) => Promise<Result> };
const tools: Record<string, Tool> = {};
const server = { registerTool(name: string, config: { inputSchema: Tool["schema"] }, run: Tool["run"]) {
  tools[name] = { schema: config.inputSchema, run };
} };
registerReadTools(server as never);
registerWriteTools(server as never);
const call = async (name: string, args = {}) => tools[name].run(z.object(tools[name].schema).parse(args));
const data = (result: Result) => JSON.parse(result.content[0].text);
let mock: MockServer;
let env: Record<string, string | undefined>;
beforeEach(async () => {
  mock = await startMockServer();
  env = Object.fromEntries(["ODIN_BASE_URL", "ODIN_API_KEY", "ODIN_BEARER_TOKEN"].map(k => [k, process.env[k]]));
  process.env.ODIN_BASE_URL = mock.url;
  process.env.ODIN_API_KEY = "odin_test";
  delete process.env.ODIN_BEARER_TOKEN;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await mock.close();
});

const writes: [string, string, string, Record<string, unknown>, unknown][] = [
  ["queue_job", "POST", "/api/v1/jobs", { model_id: 7 }, { model_id: 7, quantity: 1, priority: 3, item_name: "model 7" }],
  ["cancel_job", "POST", "/api/v1/jobs/2/cancel", { job_id: 2 }, undefined],
  ["approve_job", "POST", "/api/v1/jobs/2/approve", { job_id: 2 }, undefined],
  ["reject_job", "POST", "/api/v1/jobs/2/reject", { job_id: 2, reason: " invalid " }, { reason: "invalid" }],
  ["pause_printer", "POST", "/api/v1/printers/2/pause", { printer_id: 2 }, undefined],
  ["resume_printer", "POST", "/api/v1/printers/2/resume", { printer_id: 2 }, undefined],
  ["mark_alert_read", "PATCH", "/api/v1/alerts/2/read", { alert_id: 2 }, undefined],
  ["dismiss_alert", "PATCH", "/api/v1/alerts/2/dismiss", { alert_id: 2 }, undefined],
  ["assign_spool", "POST", "/api/v1/filament-slots", { spool_id: 1, printer_id: 2, ams_slot: 513 }, { spool_id: 1, printer_id: 2, ams_slot: 513 }],
  ["consume_spool", "PATCH", "/api/v1/spools/2/use", { spool_id: 2, grams: 12 }, { grams: 12 }],
  ["complete_maintenance", "POST", "/api/v1/maintenance/logs", { printer_id: 2, task_name: "Clean" }, { printer_id: 2, task_name: "Clean" }],
];
for (const [name, method, path, args, body] of writes) {
  test(`${name}: current method/body, preview, replay and RBAC error`, async () => {
    const response = { dry_run: true, would_execute: { action: name }, next_actions: [{ tool: "get_job", args: { id: 2 } }] };
    mock.setRoute(method, path, () => ({ status: 200, json: response, headers: { "X-Idempotent-Replay": "true" } }));
    const key = "11111111-2222-4333-8444-555555555555";
    const result = await call(name, { ...args, dry_run: true, idempotency_key: key });
    assert.equal(result.isError, undefined);
    assert.deepEqual(data(result), { ...response, _idempotent_replay: true });
    const req = mock.requests.find(r => r.method === method && r.path === path)!;
    assert.ok(req);
    assert.deepEqual(req.body, body);
    assert.equal(req.headers["idempotency-key"], key);
    assert.equal(req.headers["x-dry-run"], "true");
    assert.equal(req.headers["x-api-key"], "odin_test");
    mock.setRoute(method, path, () => ({ status: 403, json: { error: { code: "scope_denied", detail: "Denied", retriable: false, allowed_scopes: ["admin", "agent:write"] } } }));
    const denied = await call(name, args);
    assert.equal(denied.isError, true);
    assert.deepEqual(data(denied).error, { code: "scope_denied", detail: "Denied", retriable: false, allowed_scopes: ["admin", "agent:write"], status: 403 });
  });
}

const reads: [string, string, Record<string, unknown>, unknown, unknown][] = [
  ["list_printers", "/api/v1/printers", { status_filter: "printing" }, [{ id: 1, gcode_state: "IDLE", last_seen: "2099-01-01T00:00:00Z" }], { printers: [] }],
  ["get_printer", "/api/v1/printers/2", { id: 2 }, { id: 2, filament_slots: [] }, { id: 2, filament_slots: [] }],
  ["list_jobs", "/api/v1/jobs", { status_filter: "scheduled" }, [{ id: 2, status: "scheduled" }], { jobs: [{ id: 2, status: "scheduled" }] }],
  ["get_job", "/api/v1/jobs/2", { id: 2 }, { id: 2, pinned_printer_id: 4 }, { id: 2, pinned_printer_id: 4 }],
  ["list_alerts", "/api/v1/alerts", { severity: "critical", unread_only: true, limit: 40, offset: 10 }, [{ id: 2 }], { alerts: [{ id: 2 }] }],
  ["list_spools", "/api/v1/spools", { filament_type: "pla", available_only: true }, [{ id: 1, filament_material: "PLA", location_printer_id: null }, { id: 2, filament_material: "PLA", location_printer_id: 2 }, { id: 3, filament_material: "PETG", location_printer_id: null }], { spools: [{ id: 1, filament_material: "PLA", location_printer_id: null }] }],
  ["list_filaments", "/api/v1/filament-library", {}, [{ id: 1, material: "PLA" }], { filaments: [{ id: 1, material: "PLA" }] }],
  ["list_maintenance_tasks", "/api/v1/maintenance/tasks", {}, [{ id: 1, name: "Clean" }], { tasks: [{ id: 1, name: "Clean" }] }],
  ["list_orders", "/api/v1/orders", { status_filter: "fulfilled" }, [{ id: 2, status: "fulfilled" }], { orders: [{ id: 2, status: "fulfilled" }] }],
];
for (const [name, path, args, response, expected] of reads) {
  test(`${name}: response preservation, query contract and structured error`, async () => {
    mock.setRoute("GET", path, () => ({ status: 200, json: response }));
    const result = await call(name, args);
    assert.equal(result.isError, undefined);
    assert.deepEqual(data(result), expected);
    const expectedQuery = name === "list_jobs" ? { status: "scheduled", limit: "100" }
      : name === "list_alerts" ? { severity: "critical", is_read: "false", limit: "40", offset: "10" }
      : name === "list_orders" ? { status_filter: "fulfilled" } : {};
    assert.deepEqual(mock.requests[0].query, expectedQuery);
    assert.equal(mock.requests[0].headers["idempotency-key"], undefined);
    mock.setRoute("GET", path, () => ({ status: 403, json: { detail: "Insufficient permissions" } }));
    const denied = await call(name, args);
    assert.equal(denied.isError, true);
    assert.equal(data(denied).error.code, "permission_denied");
  });
}

test("overdue maintenance uses per-printer status, retaining task and printer IDs", async () => {
  mock.setRoute("GET", "/api/v1/maintenance/status", () => ({ status: 200, json: [
    { printer_id: 2, printer_name: "P2", tasks: [{ task_id: 1, status: "overdue" }, { task_id: 3, status: "ok" }] },
    { printer_id: 4, printer_name: "P4", tasks: [{ task_id: 1, status: "due_soon" }] },
  ] }));
  assert.deepEqual(data(await call("list_maintenance_tasks", { overdue_only: true })), {
    tasks: [{ task_id: 1, status: "overdue", printer_id: 2, printer_name: "P2" }],
  });
  assert.deepEqual(mock.requests[0].query, {});
});

test("queue and farm summary fetch all pages, count scheduled jobs and sort queue", async () => {
  mock.setRoute("GET", "/api/v1/printers", () => ({ status: 200, json: [{ gcode_state: "IDLE", last_seen: new Date().toISOString() }, { gcode_state: "RUNNING", last_seen: new Date().toISOString() }] }));
  mock.setRoute("GET", "/api/v1/jobs", req => {
    const count = req.query.status === "pending" ? 501 : req.query.status === "scheduled" ? 1 : 502;
    return { status: 200, json: Array.from({ length: count }, (_, i) => ({ id: i + 1, priority: req.query.status === "scheduled" ? 0 : 3, status: req.query.status })).slice(Number(req.query.offset), Number(req.query.offset) + Number(req.query.limit)) };
  });
  mock.setRoute("GET", "/api/v1/alerts", req => ({ status: 200, json: Array.from({ length: 503 }, (_, i) => ({ id: i })).slice(Number(req.query.offset), Number(req.query.offset) + Number(req.query.limit)) }));
  const queue = data(await call("list_queue")).queue;
  assert.equal(queue.length, 502);
  assert.equal(queue[0].status, "scheduled");
  assert.deepEqual(data(await call("farm_summary")), { printer_count: 2, printer_states: { idle: 1, printing: 1 }, queue_depth: 502, unread_alerts: 503, active_jobs: 502 });
  assert.ok(mock.requests.some(r => r.query.offset === "500"));
  mock.setRoute("GET", "/api/v1/printers", () => ({ status: 401, json: { detail: "Invalid or missing API key" } }));
  assert.equal((await call("farm_summary")).isError, true);
  mock.setRoute("GET", "/api/v1/jobs", () => ({ status: 403, json: { detail: "Denied" } }));
  assert.equal((await call("list_queue")).isError, true);
});

test("schemas match backend enums, one-based slots and bodyless lifecycle writes", () => {
  for (const status_filter of ["scheduled", "rejected"]) assert.ok(z.object(tools.list_jobs.schema).safeParse({ status_filter }).success);
  assert.equal(z.object(tools.list_jobs.schema).safeParse({ status_filter: "queued" }).success, false);
  for (const status_filter of ["partial", "fulfilled"]) assert.ok(z.object(tools.list_orders.schema).safeParse({ status_filter }).success);
  assert.equal(z.object(tools.list_orders.schema).safeParse({ status_filter: "completed" }).success, false);
  for (const ams_slot of [0, -1]) assert.equal(z.object(tools.assign_spool.schema).safeParse({ printer_id: 1, spool_id: 1, ams_slot }).success, false);
  assert.ok(z.object(tools.assign_spool.schema).safeParse({ printer_id: 1, spool_id: 1, ams_slot: 1 }).success);
  assert.ok(z.object(tools.queue_job.schema).safeParse({ model_id: 1, quantity: 10000 }).success);
  assert.equal(z.object(tools.queue_job.schema).safeParse({ model_id: 1, quantity: 10001 }).success, false);
  assert.equal(z.object(tools.complete_maintenance.schema).safeParse({ printer_id: 1, task_name: "   " }).success, false);
  assert.equal(tools.cancel_job.schema.reason, undefined);
  assert.equal(tools.approve_job.schema.notes, undefined);
});


test("printer states use actual gcode_state and heartbeat response fields across protocols", async () => {
  const now = Date.now();
  const states = ["IDLE", "FINISH", "RUNNING", "PRINTING", "PREPARE", "PAUSE", "PAUSED", "FAILED", "ERROR", "OFFLINE", "OTHER"];
  const printers = states.map((gcode_state, id) => ({ id, gcode_state, last_seen: new Date(now - 1000).toISOString() }));
  printers.push({ id: 12, gcode_state: "RUNNING", last_seen: new Date(now - 100000).toISOString() });
  mock.setRoute("GET", "/api/v1/printers", () => ({ status: 200, json: printers }));
  for (const [status_filter, ids] of Object.entries({ idle: [0, 1], printing: [2, 3, 4], paused: [5, 6], error: [7, 8], offline: [9, 12] })) {
    assert.deepEqual(data(await call("list_printers", { status_filter })).printers.map((p: any) => p.id), ids);
  }
});


test("environment supports API key, Bearer-only and explicit dual credentials", () => {
  assert.equal(loadClientFromEnv().apiKey, "odin_test");
  delete process.env.ODIN_API_KEY;
  process.env.ODIN_BEARER_TOKEN = "test-access-jwt";
  assert.equal(loadClientFromEnv().bearerToken, "test-access-jwt");
  process.env.ODIN_API_KEY = "odin_explicit";
  assert.equal(loadClientFromEnv().apiKey, "odin_explicit");
  delete process.env.ODIN_API_KEY;
  delete process.env.ODIN_BEARER_TOKEN;
  assert.throws(loadClientFromEnv, /ODIN_BEARER_TOKEN/);
});
