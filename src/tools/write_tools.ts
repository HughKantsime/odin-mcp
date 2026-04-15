/**
 * Write tools — require scope `agent:write` (or admin). Every tool
 * accepts `dry_run: boolean` and an optional `idempotency_key`.
 *
 * - `dry_run: true` sets the X-Dry-Run header; the backend returns
 *   `{dry_run: true, would_execute: {...}}` without committing. If
 *   the route hasn't opted in yet, the request proceeds normally
 *   (per Phase 1 infrastructure-only design).
 * - `idempotency_key` defaults to a fresh UUID per call. Pass a
 *   stable value across retries so the backend dedupes.
 *
 * Phase 1 backend guarantees every caller should rely on:
 *   - 2xx → mutation succeeded exactly once for this key
 *   - 409 idempotency_conflict → same key + different body; use a
 *     fresh key for a new request
 *   - 409 idempotency_in_progress → concurrent retry, try again in
 *     a moment
 *   - 409 idempotency_authz_changed → user role/scope changed since
 *     the key's original success; mint a fresh key
 *   - 409 idempotency_uncacheable_success → the first call succeeded
 *     but the response couldn't be cached (rare on write routes);
 *     don't retry under this key
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadClientFromEnv, odinPost, odinPatch, OdinApiError } from "../client.js";

function writeErrorToResult(err: unknown) {
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
        text: `ODIN write tool failed: ${(err as Error)?.message ?? String(err)}`,
      },
    ],
    isError: true,
  };
}

function writeOk(body: unknown, replay: boolean) {
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

// Common fields every write tool accepts.
const writeControls = {
  dry_run: z
    .boolean()
    .default(false)
    .describe("If true, validate + preview the call without committing. Backend returns would_execute."),
  idempotency_key: z
    .string()
    .uuid()
    .optional()
    .describe("UUIDv4. Pass a stable value across retries to deduplicate. Default = fresh per call."),
};

export function registerWriteTools(server: McpServer): void {
  const _client = () => loadClientFromEnv();

  // ----- queue_job -----
  server.registerTool(
    "queue_job",
    {
      description:
        "Add a print job to the queue. Optionally pin to a specific printer; " +
        "otherwise the scheduler assigns based on capability match.",
      inputSchema: {
        model_id: z.number().int().positive().describe("Model from the library"),
        printer_id: z.number().int().positive().optional().describe("Optional target printer"),
        quantity: z.number().int().min(1).max(100).default(1),
        priority: z.number().int().min(1).max(10).default(3),
        notes: z.string().max(500).optional(),
        ...writeControls,
      },
    },
    async ({ model_id, printer_id, quantity, priority, notes, dry_run, idempotency_key }) => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinPost(cfg, "/api/v1/jobs", {
          body: {
            model_id,
            printer_id,
            quantity,
            priority,
            notes,
            item_name: notes?.slice(0, 80) ?? `model ${model_id}`,
          },
          dryRun: dry_run,
          idempotencyKey: idempotency_key,
        });
        return writeOk(body as object, idempotentReplay);
      } catch (err) {
        return writeErrorToResult(err);
      }
    },
  );

  // ----- cancel_job -----
  server.registerTool(
    "cancel_job",
    {
      description: "Cancel a pending / queued / printing job.",
      inputSchema: {
        job_id: z.number().int().positive(),
        reason: z.string().max(500).optional(),
        ...writeControls,
      },
    },
    async ({ job_id, reason, dry_run, idempotency_key }) => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinPost(cfg, `/api/v1/jobs/${job_id}/cancel`, {
          body: { reason },
          dryRun: dry_run,
          idempotencyKey: idempotency_key,
        });
        return writeOk(body as object, idempotentReplay);
      } catch (err) {
        return writeErrorToResult(err);
      }
    },
  );

  // ----- approve_job -----
  server.registerTool(
    "approve_job",
    {
      description: "Approve a submitted job (for approval-workflow farms).",
      inputSchema: {
        job_id: z.number().int().positive(),
        notes: z.string().max(500).optional(),
        ...writeControls,
      },
    },
    async ({ job_id, notes, dry_run, idempotency_key }) => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinPost(cfg, `/api/v1/jobs/${job_id}/approve`, {
          body: { notes },
          dryRun: dry_run,
          idempotencyKey: idempotency_key,
        });
        return writeOk(body as object, idempotentReplay);
      } catch (err) {
        return writeErrorToResult(err);
      }
    },
  );

  // ----- reject_job -----
  server.registerTool(
    "reject_job",
    {
      description: "Reject a submitted job. Reason is required and shown to the submitter.",
      inputSchema: {
        job_id: z.number().int().positive(),
        reason: z.string().min(1).max(500),
        ...writeControls,
      },
    },
    async ({ job_id, reason, dry_run, idempotency_key }) => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinPost(cfg, `/api/v1/jobs/${job_id}/reject`, {
          body: { reason },
          dryRun: dry_run,
          idempotencyKey: idempotency_key,
        });
        return writeOk(body as object, idempotentReplay);
      } catch (err) {
        return writeErrorToResult(err);
      }
    },
  );

  // ----- pause_printer -----
  server.registerTool(
    "pause_printer",
    {
      description: "Pause the currently-printing job on a printer.",
      inputSchema: {
        printer_id: z.number().int().positive(),
        ...writeControls,
      },
    },
    async ({ printer_id, dry_run, idempotency_key }) => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinPost(cfg, `/api/v1/printers/${printer_id}/pause`, {
          dryRun: dry_run,
          idempotencyKey: idempotency_key,
        });
        return writeOk(body as object, idempotentReplay);
      } catch (err) {
        return writeErrorToResult(err);
      }
    },
  );

  // ----- resume_printer -----
  server.registerTool(
    "resume_printer",
    {
      description: "Resume a paused printer.",
      inputSchema: {
        printer_id: z.number().int().positive(),
        ...writeControls,
      },
    },
    async ({ printer_id, dry_run, idempotency_key }) => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinPost(cfg, `/api/v1/printers/${printer_id}/resume`, {
          dryRun: dry_run,
          idempotencyKey: idempotency_key,
        });
        return writeOk(body as object, idempotentReplay);
      } catch (err) {
        return writeErrorToResult(err);
      }
    },
  );

  // ----- mark_alert_read -----
  server.registerTool(
    "mark_alert_read",
    {
      description: "Mark a single alert as read.",
      inputSchema: {
        alert_id: z.number().int().positive(),
        ...writeControls,
      },
    },
    async ({ alert_id, dry_run, idempotency_key }) => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinPatch(cfg, `/api/v1/alerts/${alert_id}/read`, {
          dryRun: dry_run,
          idempotencyKey: idempotency_key,
        });
        return writeOk(body as object, idempotentReplay);
      } catch (err) {
        return writeErrorToResult(err);
      }
    },
  );

  // ----- dismiss_alert -----
  server.registerTool(
    "dismiss_alert",
    {
      description: "Dismiss an alert (hides it from the dashboard).",
      inputSchema: {
        alert_id: z.number().int().positive(),
        ...writeControls,
      },
    },
    async ({ alert_id, dry_run, idempotency_key }) => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinPatch(cfg, `/api/v1/alerts/${alert_id}/dismiss`, {
          dryRun: dry_run,
          idempotencyKey: idempotency_key,
        });
        return writeOk(body as object, idempotentReplay);
      } catch (err) {
        return writeErrorToResult(err);
      }
    },
  );

  // ----- assign_spool -----
  server.registerTool(
    "assign_spool",
    {
      description: "Assign a spool to a printer's AMS slot.",
      inputSchema: {
        spool_id: z.number().int().positive(),
        printer_id: z.number().int().positive(),
        ams_slot: z.number().int().min(0).max(15).optional().describe("AMS slot index; omit for non-AMS printers."),
        ...writeControls,
      },
    },
    async ({ spool_id, printer_id, ams_slot, dry_run, idempotency_key }) => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinPost(cfg, `/api/v1/filament-slots`, {
          body: { spool_id, printer_id, ams_slot },
          dryRun: dry_run,
          idempotencyKey: idempotency_key,
        });
        return writeOk(body as object, idempotentReplay);
      } catch (err) {
        return writeErrorToResult(err);
      }
    },
  );

  // ----- consume_spool -----
  server.registerTool(
    "consume_spool",
    {
      description: "Record filament consumption (grams used) against a spool.",
      inputSchema: {
        spool_id: z.number().int().positive(),
        grams: z.number().positive().max(10_000),
        ...writeControls,
      },
    },
    async ({ spool_id, grams, dry_run, idempotency_key }) => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinPatch(cfg, `/api/v1/spools/${spool_id}/use`, {
          body: { grams },
          dryRun: dry_run,
          idempotencyKey: idempotency_key,
        });
        return writeOk(body as object, idempotentReplay);
      } catch (err) {
        return writeErrorToResult(err);
      }
    },
  );

  // ----- complete_maintenance -----
  server.registerTool(
    "complete_maintenance",
    {
      description: "Log completion of a maintenance task (ODIN's maintenance-logs model).",
      inputSchema: {
        task_id: z.number().int().positive(),
        notes: z.string().max(500).optional(),
        ...writeControls,
      },
    },
    async ({ task_id, notes, dry_run, idempotency_key }) => {
      try {
        const cfg = _client();
        const { body, idempotentReplay } = await odinPost(cfg, `/api/v1/maintenance/logs`, {
          body: { task_id, notes },
          dryRun: dry_run,
          idempotencyKey: idempotency_key,
        });
        return writeOk(body as object, idempotentReplay);
      } catch (err) {
        return writeErrorToResult(err);
      }
    },
  );
}
