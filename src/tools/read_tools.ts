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
import { loadClientFromEnv, odinGet, OdinApiError } from "../client.js";

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
        const { body, idempotentReplay } = await odinGet<unknown[]>(
          cfg,
          "/api/v1/printers",
          { query: { status: status_filter } },
        );
        return okResult({ printers: body }, idempotentReplay);
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
        "Full status of a single printer — telemetry, active job, AMS slots, temperatures.",
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
          .enum(["pending", "submitted", "queued", "printing", "completed", "failed", "cancelled", "paused"])
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
      description: "List pending/queued jobs ordered by priority.",
      inputSchema: {},
    },
    async () => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinGet(cfg, "/api/v1/jobs", {
          query: { status: "pending" },
        });
        return okResult({ queue: body }, idempotentReplay);
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
      },
    },
    async ({ severity, unread_only }) => {
      try {
        const cfg = _client();
        const query: Record<string, string | number | boolean | undefined> = {};
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
        const { body, idempotentReplay } = await odinGet(cfg, "/api/v1/spools", {
          query: {
            filament_type: filament_type,
            available_only: available_only ? true : undefined,
          },
        });
        return okResult({ spools: body }, idempotentReplay);
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
      description: "List printer maintenance tasks (nozzle changes, belt tension, etc).",
      inputSchema: {
        overdue_only: z.boolean().default(false),
      },
    },
    async ({ overdue_only }) => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinGet(cfg, "/api/v1/maintenance/tasks", {
          query: { overdue: overdue_only ? true : undefined },
        });
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
          .enum(["pending", "in_progress", "completed", "shipped", "cancelled"])
          .optional(),
      },
    },
    async ({ status_filter }) => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinGet(cfg, "/api/v1/orders", {
          query: { status: status_filter },
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
          odinGet<unknown[]>(cfg, "/api/v1/jobs", { query: { status: "pending" } }),
          odinGet<unknown[]>(cfg, "/api/v1/alerts", { query: { is_read: false } }),
          odinGet<unknown[]>(cfg, "/api/v1/jobs", { query: { status: "printing" } }),
        ]);

        const printerList = printers.body ?? [];
        const stateCounts: Record<string, number> = {};
        for (const p of printerList as Array<Record<string, unknown>>) {
          const state = String((p as { status?: string }).status ?? "unknown");
          stateCounts[state] = (stateCounts[state] ?? 0) + 1;
        }

        return okResult(
          {
            printer_count: printerList.length,
            printer_states: stateCounts,
            queue_depth: (queue.body as unknown[] | undefined)?.length ?? 0,
            unread_alerts: (alerts.body as unknown[] | undefined)?.length ?? 0,
            active_jobs: (jobs.body as unknown[] | undefined)?.length ?? 0,
          },
          false,
        );
      } catch (err) {
        return errorToResult(err);
      }
    },
  );
}
