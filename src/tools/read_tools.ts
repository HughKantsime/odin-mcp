/**
 * Read-only tools — safe for any agent with scope `agent:read` or
 * higher. No state mutation, no idempotency-key needed.
 *
 * Each tool:
 *   - Has a Zod input schema (bounded so the MCP SDK validates
 *     agent-supplied args before we hit the network).
 *   - Returns the JSON shape ODIN emits — agents branch on keys.
 *   - Surfaces `X-Idempotent-Replay: true` on the output when the
 *     underlying call replayed (rare for GETs, but preserved for
 *     consistency).
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadClientFromEnv, odinGet, OdinApiError, type OdinClientConfig } from "../client.js";

function errorToResult(err: unknown) {
  if (err instanceof OdinApiError) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: {
              code: err.code,
              detail: err.detail,
              retriable: err.retriable,
              status: err.status,
              ...err.extra,
            },
          }),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text" as const,
        text: `ODIN read tool failed: ${(err as Error)?.message ?? String(err)}`,
      },
    ],
    isError: true,
  };
}

function okResult(body: unknown, replay: boolean) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ...(body as object),
          ...(replay ? { _idempotent_replay: true } : {}),
        }),
      },
    ],
  };
}

type Row = Record<string, unknown>;

// Match ODIN's protocol-neutral state vocabulary and 90-second heartbeat rule.
function printerState(printer: Row): string {
  const state = String(printer.gcode_state ?? "").trim().toUpperCase();
  const timestamp = String(printer.last_seen ?? "").trim();
  const lastSeen = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp) ? timestamp : `${timestamp}Z`);
  const age = Date.now() - lastSeen;
  if (state === "OFFLINE" || !Number.isFinite(lastSeen) || age < 0 || age >= 90_000) return "offline";
  if (["RUNNING", "PRINTING", "PREPARE"].includes(state)) return "printing";
  if (["PAUSE", "PAUSED"].includes(state)) return "paused";
  if (["FAILED", "ERROR"].includes(state)) return "error";
  if (["IDLE", "FINISH", "READY"].includes(state)) return "idle";
  return "unknown";
}

// ODIN jobs and alerts return bare arrays with limit/offset pagination.
async function allPages(cfg: OdinClientConfig, path: string, query: Record<string, string | number | boolean> = {}): Promise<Row[]> {
  const rows: Row[] = [];
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    const { body } = await odinGet<Row[]>(cfg, path, { query: { ...query, limit, offset } });
    rows.push(...body);
    if (body.length < limit) return rows;
  }
}

async function readQueue(cfg: OdinClientConfig): Promise<Row[]> {
  const [pending, scheduled] = await Promise.all([
    allPages(cfg, "/api/v1/jobs", { status: "pending" }),
    allPages(cfg, "/api/v1/jobs", { status: "scheduled" }),
  ]);
  return [...pending, ...scheduled].sort((a, b) =>
    Number(a.priority ?? 3) - Number(b.priority ?? 3) ||
    Number(a.queue_position ?? Infinity) - Number(b.queue_position ?? Infinity) ||
    String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || Number(a.id) - Number(b.id));
}

export function registerReadTools(server: McpServer): void {
  const _client = () => loadClientFromEnv();

  // ----- list_printers -----
  server.registerTool(
    "list_printers",
    {
      description:
        "List every printer ODIN manages. Optionally filter by status " +
        "(idle/printing/paused/offline/error).",
      inputSchema: {
        status_filter: z
          .enum(["idle", "printing", "paused", "offline", "error"])
          .optional()
          .describe("Only return printers in this state."),
      },
    },
    async ({ status_filter }) => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinGet<Row[]>(cfg, "/api/v1/printers");
        return okResult({ printers: status_filter ? body.filter(p => printerState(p) === status_filter) : body }, idempotentReplay);
      } catch (err) {
        return errorToResult(err);
      }
    },
  );

  // ----- get_printer -----
  server.registerTool(
    "get_printer",
    {
      description:
        "Printer record with persisted telemetry, filament slots and temperatures.",
      inputSchema: {
        id: z.number().int().positive().describe("Printer ID"),
      },
    },
    async ({ id }) => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinGet(cfg, `/api/v1/printers/${id}`);
        return okResult(body as object, idempotentReplay);
      } catch (err) {
        return errorToResult(err);
      }
    },
  );

  // ----- list_jobs -----
  server.registerTool(
    "list_jobs",
    {
      description:
        "List jobs with optional filters. Use this to find what's in the queue, " +
        "what's currently printing, what recently failed, etc.",
      inputSchema: {
        status_filter: z
          .enum(["pending", "submitted", "scheduled", "rejected", "printing", "completed", "failed", "cancelled", "paused"])
          .optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    async ({ status_filter, limit }) => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinGet(cfg, "/api/v1/jobs", {
          query: { status: status_filter, limit },
        });
        return okResult({ jobs: body }, idempotentReplay);
      } catch (err) {
        return errorToResult(err);
      }
    },
  );

  // ----- get_job -----
  server.registerTool(
    "get_job",
    {
      description: "Full status of a single job — printer assignment, duration, cost, notes.",
      inputSchema: { id: z.number().int().positive() },
    },
    async ({ id }) => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinGet(cfg, `/api/v1/jobs/${id}`);
        return okResult(body as object, idempotentReplay);
      } catch (err) {
        return errorToResult(err);
      }
    },
  );

  // ----- list_queue -----
  server.registerTool(
    "list_queue",
    {
      description: "List all pending and scheduled jobs ordered by priority, queue position and age.",
      inputSchema: {},
    },
    async () => {
      try {
        const cfg = _client();
        return okResult({ queue: await readQueue(cfg) }, false);
      } catch (err) {
        return errorToResult(err);
      }
    },
  );

  // ----- list_alerts -----
  server.registerTool(
    "list_alerts",
    {
      description: "List farm alerts. Filter by severity and/or unread.",
      inputSchema: {
        severity: z.enum(["info", "warning", "critical"]).optional(),
        unread_only: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ severity, unread_only, limit, offset }) => {
      try {
        const cfg = _client();
        const query: Record<string, string | number | boolean | undefined> = { limit, offset };
        if (severity) query.severity = severity;
        if (unread_only) query.is_read = false;
        const { body, idempotentReplay } = await odinGet(cfg, "/api/v1/alerts", { query });
        return okResult({ alerts: body }, idempotentReplay);
      } catch (err) {
        return errorToResult(err);
      }
    },
  );

  // ----- list_spools -----
  server.registerTool(
    "list_spools",
    {
      description: "List filament spools in the farm inventory.",
      inputSchema: {
        filament_type: z
          .string()
          .optional()
          .describe("PLA, PETG, ABS, etc. — filters to matching spools."),
        available_only: z
          .boolean()
          .default(false)
          .describe("True → only spools not currently loaded in a printer."),
      },
    },
    async ({ filament_type, available_only }) => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinGet<Row[]>(cfg, "/api/v1/spools");
        const spools = body.filter(spool =>
          (!filament_type || String(spool.filament_material ?? "").toLowerCase() === filament_type.toLowerCase()) &&
          (!available_only || spool.location_printer_id == null));
        return okResult({ spools }, idempotentReplay);
      } catch (err) {
        return errorToResult(err);
      }
    },
  );

  // ----- list_filaments -----
  server.registerTool(
    "list_filaments",
    {
      description: "List filament types configured in the library.",
      inputSchema: {},
    },
    async () => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinGet(cfg, "/api/v1/filament-library");
        return okResult({ filaments: body }, idempotentReplay);
      } catch (err) {
        return errorToResult(err);
      }
    },
  );

  // ----- list_maintenance_tasks -----
  server.registerTool(
    "list_maintenance_tasks",
    {
      description: "List maintenance templates; overdue_only returns overdue per-printer task health with task_id and printer_id.",
      inputSchema: {
        overdue_only: z.boolean().default(false),
      },
    },
    async ({ overdue_only }) => {
      try {
        const cfg = _client();
        if (overdue_only) {
          const { body } = await odinGet<Array<Row & { tasks: Row[] }>>(cfg, "/api/v1/maintenance/status");
          const tasks = body.flatMap(printer => printer.tasks
            .filter(task => task.status === "overdue")
            .map(task => ({ ...task, printer_id: printer.printer_id, printer_name: printer.printer_name })));
          return okResult({ tasks }, false);
        }
        const { body, idempotentReplay } = await odinGet(cfg, "/api/v1/maintenance/tasks");
        return okResult({ tasks: body }, idempotentReplay);
      } catch (err) {
        return errorToResult(err);
      }
    },
  );

  // ----- list_orders -----
  server.registerTool(
    "list_orders",
    {
      description: "List customer orders / print requests.",
      inputSchema: {
        status_filter: z
          .enum(["pending", "in_progress", "partial", "fulfilled", "shipped", "cancelled"])
          .optional(),
      },
    },
    async ({ status_filter }) => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinGet(cfg, "/api/v1/orders", {
          query: { status_filter },
        });
        return okResult({ orders: body }, idempotentReplay);
      } catch (err) {
        return errorToResult(err);
      }
    },
  );

  // ----- farm_summary -----
  server.registerTool(
    "farm_summary",
    {
      description:
        "One-shot dashboard: printer counts by state, queue depth, unread alerts, " +
        "active jobs. Intended as the first call an agent makes to orient itself.",
      inputSchema: {},
    },
    async () => {
      try {
        const cfg = _client();
        // Compose the summary from multiple read calls — the backend
        // doesn't expose a dedicated /farm_summary endpoint yet, so
        // the tool layer assembles it. Each call is independent.
        const [printers, queue, alerts, jobs] = await Promise.all([
          odinGet<unknown[]>(cfg, "/api/v1/printers"),
          readQueue(cfg),
          allPages(cfg, "/api/v1/alerts", { is_read: false }),
          allPages(cfg, "/api/v1/jobs", { status: "printing" }),
        ]);

        const printerList = printers.body ?? [];
        const stateCounts: Record<string, number> = {};
        for (const p of printerList as Array<Record<string, unknown>>) {
          const state = printerState(p);
          stateCounts[state] = (stateCounts[state] ?? 0) + 1;
        }

        return okResult(
          {
            printer_count: printerList.length,
            printer_states: stateCounts,
            queue_depth: queue.length,
            unread_alerts: alerts.length,
            active_jobs: jobs.length,
          },
          false,
        );
      } catch (err) {
        return errorToResult(err);
      }
    },
  );
}
