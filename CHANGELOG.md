# Changelog

## [2.0.0] - 2026-04-15

### Added — live agent surface (22 tools)

The package now bundles a full live-operation tool surface that
drives a running O.D.I.N. instance. Set `ODIN_BASE_URL` and
`ODIN_API_KEY` in the client environment to enable.

**Read tools** (11, scope `agent:read` or higher):
`farm_summary`, `list_printers`, `get_printer`, `list_jobs`,
`get_job`, `list_queue`, `list_alerts`, `list_spools`,
`list_filaments`, `list_maintenance_tasks`, `list_orders`.

**Write tools** (11, scope `agent:write` or admin): `queue_job`,
`cancel_job`, `approve_job`, `reject_job`, `pause_printer`,
`resume_printer`, `mark_alert_read`, `dismiss_alert`, `assign_spool`,
`consume_spool`, `complete_maintenance`. Each accepts optional
`dry_run` and `idempotency_key` inputs.

### Added — agent retry primitives

- **Auto-generated Idempotency-Key** on every write call; callers
  pass a stable `idempotency_key` across retries to deduplicate.
- **X-Dry-Run** forwarding — passes `dry_run: true` as the header
  when the tool input contains it. Backend returns
  `{dry_run: true, would_execute: {...}}`.
- **Error envelope parser** throws `OdinApiError` on 4xx/5xx with
  `.code / .detail / .retriable / .extra`. Agents branch on
  `err.code`.
- **Replay surfacing** — responses with `X-Idempotent-Replay: true`
  set `idempotentReplay: true` on the client response and the tool
  output includes `_idempotent_replay: true` for agent visibility.

### Added — tests

22 integration tests (`test/client.test.ts`) against a node-native
mock server (`test/mock_server.ts`). Covers every client contract
point: auth headers, idempotency-key auto-gen + passthrough,
dry-run, Content-Length on empty-body mutators, dual-shape error
parsing with extras, 409 flavors (conflict / in_progress / authz /
uncacheable), timeout, nonexistent host, non-JSON responses. Runs
in ~1s.

### Changed

- **BREAKING: major version bump to 2.0.0.** v1 tools continue to
  work unchanged (additive release); `npx -y odin-print-farm-mcp@1`
  pinned in existing MCP client configs keeps behaving identically.
  The 22 new live tools are additive and error at invocation if
  `ODIN_BASE_URL` / `ODIN_API_KEY` aren't set, so the 4 reference
  tools remain fully standalone.

### Requires

- O.D.I.N. backend v1.8.9+ for the live surface. The reference
  tools (`calculate_print_cost`, `recommend_printer_for_farm`,
  `estimate_farm_capacity`, `compare_farm_software`) are unchanged
  from v1 and have no backend requirement.

## [1.0.0] - 2026-02-XX

Initial release — reference tools only.
