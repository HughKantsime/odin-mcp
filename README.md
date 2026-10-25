# odin-print-farm-mcp

Model Context Protocol server for O.D.I.N. — drive an actual print farm with AI agents, or run the bundled reference calculators standalone.

**v2** (2026-04-15) splits the surface in two:

- **Live tools** (22) — agent-driven farm operation. Require a running O.D.I.N. instance + a scoped token. Queue jobs, pause printers, manage inventory, clear alerts, log maintenance, read the dashboard.
- **Reference tools** (4) — standalone calculators. No ODIN deployment required. Print-cost math, printer recommendations, farm capacity planning, software comparison.

Both surfaces ship in the same npm package; the live tools error at invocation if `ODIN_BASE_URL` and credentials aren't set, so the reference tools keep working for pre-sales and research use cases.

---

## Quick Start

### Standalone (reference tools only)

```bash
npx -y odin-print-farm-mcp@2
```

Wire into Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "odin-reference": {
      "command": "npx",
      "args": ["-y", "odin-print-farm-mcp@2"]
    }
  }
}
```

Agents can now use `reference.calculate_print_cost`, `reference.recommend_printer_for_farm`, `reference.estimate_farm_capacity`, `reference.compare_farm_software`.

### Live (connected to O.D.I.N.)

1. Mint an API token in O.D.I.N. (**Settings → API Tokens → New Token**) with scope `agent:read` or `agent:write`.
2. Export the env vars and wire the client:

```json
{
  "mcpServers": {
    "odin": {
      "command": "npx",
      "args": ["-y", "odin-print-farm-mcp@2"],
      "env": {
        "ODIN_BASE_URL": "http://192.168.1.100:8000",
        "ODIN_API_KEY": "odin_xxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

All 26 tools are now available.

---

## Tools

### Live reads (scope `agent:read` or higher)

| Tool | Purpose |
|------|---------|
| `farm_summary` | One-shot dashboard: printer counts by state, queue depth, unread alerts, active jobs. Call this first to orient. |
| `list_printers` | Fleet list, optional status filter. |
| `get_printer` | Printer record with persisted telemetry, filament slots and temperatures. |
| `list_jobs` | Filter by status (pending / printing / completed / failed / cancelled). |
| `get_job` | Full job record. |
| `list_queue` | All pending and scheduled jobs in priority, queue-position and age order. |
| `list_alerts` | Filter by severity + read state; `limit` (default 100, max 500) and `offset` page results. |
| `list_spools` | Filter by filament type / availability. |
| `list_filaments` | Filament library. |
| `list_maintenance_tasks` | Templates, or overdue per-printer task health with `overdue_only`. |
| `list_orders` | Customer orders by status. |

### Live writes (scope `agent:write` or admin)

Every write tool accepts optional `dry_run` and `idempotency_key`.

| Tool | Purpose |
|------|---------|
| `queue_job` | Add a job from a model library ID. Accepts `model_id`, optional `item_name`, `quantity`, `priority`, and `notes`; the ODIN scheduler assigns the printer. |
| `cancel_job` | Cancel a pending or scheduled job; this route does not accept a reason or stop a printing job. |
| `approve_job` | Approve a submitted job. |
| `reject_job` | Reject a job (reason required). |
| `pause_printer` | Pause the active print. |
| `resume_printer` | Resume a paused printer. |
| `mark_alert_read` / `dismiss_alert` | Alert housekeeping. |
| `assign_spool` | Bind spool → printer slot (`ams_slot` is the one-based slot number from `get_printer`, default 1). |
| `consume_spool` | Log grams used. |
| `complete_maintenance` | Log task completion. Requires `printer_id` and `task_name`; `task_id` is optional. |

### Reference (no backend)

| Tool | Purpose |
|------|---------|
| `reference.calculate_print_cost` | Material + electricity + depreciation + failure-rate math. |
| `reference.recommend_printer_for_farm` | Match printers to farm constraints. |
| `reference.estimate_farm_capacity` | Throughput forecasting. |
| `reference.compare_farm_software` | Feature matrix vs OctoFarm / Mainsail / Duet / etc. |

---

## Agent Primitives

The live surface inherits four retry-safety primitives from the O.D.I.N. v1.8.9 backend:

**Idempotency-Key.** Every write tool auto-generates a UUID key per call; pass a stable `idempotency_key` across retries to deduplicate. On replay, the response comes back with `_idempotent_replay: true`.

**X-Dry-Run.** Pass `dry_run: true` to any write tool. The backend returns `{dry_run: true, would_execute: {...}}` without committing. Per-route opt-in — individual routes land preview branches in subsequent releases.

**Structured errors.** Failures return an `error: {code, detail, retriable}` envelope. Stable codes agents can branch on:

| Code | Meaning |
|------|---------|
| `printer_not_found` / `job_not_found` / `spool_not_found` / `alert_not_found` | Resource missing. |
| `scope_denied` | Token scope insufficient. Mint a broader token. |
| `permission_denied` | Role-based denial (role, not scope). |
| `quota_exceeded` | Usage quota hit. `extra.used_grams` / `extra.limit_grams`. |
| `idempotency_conflict` | Same key + different body. Use a fresh key. |
| `idempotency_in_progress` | Concurrent retry in flight. Retry shortly. |
| `idempotency_authz_changed` | Role/scope changed since the original call. Mint a fresh key. |
| `idempotency_uncacheable_success` | Original succeeded but couldn't be cached. Mint a fresh key. |
| `idempotency_unsupported` | Multipart or oversized body — use app-level dedup. |
| `itar_outbound_blocked` | ODIN_ITAR_MODE=1 refused a public destination. |
| `rate_limited` | `retriable: true`. |
| `validation_failed` | Input schema error. |

**next_actions hints.** Write responses include `next_actions: [{tool, args?, reason?}]` suggesting follow-up calls. Pure hint — no enforcement. Designed for 7B–32B local models.

---

## ITAR / CMMC Deployment

O.D.I.N. ships `ODIN_ITAR_MODE=1` for fail-closed air-gap deployments. Typical stack:

```
   Ollama (Qwen2.5-32B or similar)
      │
      ▼
   MCP client (Claude Desktop / OpenClaw / etc.)
      │ stdio
      ▼
   odin-print-farm-mcp@2  ── ODIN_BASE_URL=http://localhost:8000
      │ HTTP
      ▼
   O.D.I.N. backend  ── ODIN_ITAR_MODE=1
      │ LAN
      ▼
   Printers (LAN-only)
```

Zero outbound packets. All tokens, prompts, and telemetry stay inside the compliance boundary. See the [ITAR / CMMC mode docs](https://runsodin.com/docs/configuration/itar-mode).

---

## Migration from v1

v2.0.1 renames the four v1 tools into a `reference.*` namespace:

| v1 | v2 |
|----|----|
| `calculate_print_cost` | `reference.calculate_print_cost` |
| `recommend_printer_for_farm` | `reference.recommend_printer_for_farm` |
| `estimate_farm_capacity` | `reference.estimate_farm_capacity` |
| `compare_farm_software` | `reference.compare_farm_software` |

The behavior of each tool is unchanged — only the identifier. Pin `odin-print-farm-mcp@1` if you need the un-namespaced IDs. Upgrade to `@2` to access the 22 live tools plus the namespaced reference calculators.

---

## Skill packages

The `skills/` directory ships operator-ready prompt packs for Claude Code, OpenClaw, Cline, and other MCP clients. `odin-farm/SKILL.md` is the baseline "safe farm operator" rulebook — dry-run-first, branch on error codes, never batch cancellations. Drop it into `~/.claude/skills/` (Claude Code) or your client's skills directory, and a local 32B model will stop trying to cancel jobs without confirmation.

See [`skills/README.md`](./skills/README.md) for install + customization.

---

## Development

```bash
git clone https://github.com/HughKantsime/odin-mcp
cd odin-mcp
npm install
npm run build
npm test  # 22 integration tests against an in-process mock ODIN
```

Tests use a node-native http mock server (`test/mock_server.ts`) — no external fixtures, no ODIN instance required, runs in ~1s.

---

## Links

- [O.D.I.N.](https://runsodin.com) — the backend this talks to
- [MCP docs on runsodin.com](https://runsodin.com/docs/integrations/mcp-server)
- [Model Context Protocol spec](https://modelcontextprotocol.io)
- [npm package](https://www.npmjs.com/package/odin-print-farm-mcp)

## License

Apache 2.0.

### ODIN 2.0.13 authentication and permissions

Set `ODIN_BEARER_TOKEN` to an access JWT for Bearer authentication instead of
`ODIN_API_KEY`. When both are explicitly configured, both headers are sent;
ODIN rejects an invalid explicit API key at its perimeter even with a valid JWT.
The dry-run version probe uses the same credentials. No login, token renewal or
credential fallback is performed by this server.

Scoped user tokens require `agent:read` for reads or `agent:write` for writes
(and reads); `admin` scope is also accepted. The owning user's role and the
current Settings → Permissions action matrix still apply. JWT sessions bypass
token-scope checks but retain role/action checks. Legacy global API keys resolve
to ODIN's backend admin; they are not scoped user tokens. License and Education
workflow restrictions remain server-enforced; scopes do not override them.

Printer state and spool material/availability filters run locally because ODIN
does not accept those query parameters. Orders use `status_filter`; job states
include `scheduled` and `rejected`, and order states include `partial` and
`fulfilled`. Queue and summary calls page through all job/alert results. These
multiple reads are not an atomic snapshot of a changing farm.

See [the compatibility audit](docs/odin-2.0.13-audit.html) for every tool's route,
permissions, fixes and follow-up capabilities.
