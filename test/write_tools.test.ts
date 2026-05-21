import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { registerWriteTools } from "../src/tools/write_tools.ts";
import { startMockServer, type MockServer } from "./mock_server.ts";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function registerTestTools(): Record<string, ToolHandler> {
  const handlers: Record<string, ToolHandler> = {};
  registerWriteTools({
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      handlers[name] = handler;
    },
  } as never);
  return handlers;
}

let mock: MockServer;
let oldBaseUrl: string | undefined;
let oldApiKey: string | undefined;

beforeEach(async () => {
  mock = await startMockServer();
  oldBaseUrl = process.env.ODIN_BASE_URL;
  oldApiKey = process.env.ODIN_API_KEY;
  process.env.ODIN_BASE_URL = mock.url;
  process.env.ODIN_API_KEY = "odin_test_token_xxxxxxxxxx";
});

afterEach(async () => {
  if (oldBaseUrl === undefined) delete process.env.ODIN_BASE_URL;
  else process.env.ODIN_BASE_URL = oldBaseUrl;
  if (oldApiKey === undefined) delete process.env.ODIN_API_KEY;
  else process.env.ODIN_API_KEY = oldApiKey;
  await mock.close();
});

describe("write tools — backend payload contracts", () => {
  test("queue_job sends only JobCreate-supported fields", async () => {
    const tools = registerTestTools();
    mock.setRoute("POST", "/api/v1/jobs", () => ({
      status: 201,
      json: { id: 42, item_name: "bracket" },
    }));

    await tools.queue_job({
      model_id: 7,
      item_name: "bracket",
      quantity: 2,
      priority: 4,
      notes: "customer rush",
      dry_run: false,
    });

    const req = mock.requests.find((r) => r.method === "POST" && r.path === "/api/v1/jobs");
    assert.ok(req, "Expected queue_job to POST /api/v1/jobs");
    assert.deepEqual(req.body, {
      model_id: 7,
      quantity: 2,
      priority: 4,
      notes: "customer rush",
      item_name: "bracket",
    });
    assert.equal((req.body as Record<string, unknown>).printer_id, undefined);
  });

  test("complete_maintenance sends required MaintenanceLogCreate fields", async () => {
    const tools = registerTestTools();
    mock.setRoute("POST", "/api/v1/maintenance/logs", () => ({
      status: 201,
      json: { id: 9, message: "Maintenance logged" },
    }));

    await tools.complete_maintenance({
      printer_id: 3,
      task_id: 12,
      task_name: "Nozzle inspection",
      notes: "Looks clean",
      dry_run: false,
    });

    const req = mock.requests.find(
      (r) => r.method === "POST" && r.path === "/api/v1/maintenance/logs",
    );
    assert.ok(req, "Expected complete_maintenance to POST /api/v1/maintenance/logs");
    assert.deepEqual(req.body, {
      printer_id: 3,
      task_id: 12,
      task_name: "Nozzle inspection",
      notes: "Looks clean",
    });
  });
});
