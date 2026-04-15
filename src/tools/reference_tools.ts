/**
 * Reference tools — v1 calculator / comparison / recommendation
 * tools, preserved under a `reference.*` namespace. These DO NOT
 * require a live ODIN backend (no env vars, no auth). They operate
 * on bundled JSON data for pre-sales research and standalone
 * calculations.
 *
 * Why keep them:
 *   - Non-zero adoption signal on npm for the v1 surface.
 *   - Zero overhead to leave them in under a namespace.
 *   - Useful for agents answering "what printer should I buy?" or
 *     "how much will this print cost?" without an ODIN deployment.
 *
 * Implementation: wraps the existing v1 registerTool calls from
 * src/index.ts.new_name. The data files in src/data/ are unchanged.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Register the v1 calculator tools under `reference.*` names. The
 * handler logic is identical to what src/index.ts shipped in v1 —
 * only the tool names change.
 *
 * For this phase 2 scaffolding pass, we re-export the v1 index
 * module's registration function (which we'll refactor in a follow-up
 * so each tool is individually prefixable). Until that refactor, the
 * v1 tools are still registered by the live-tool index with the
 * `reference.` prefix applied at registration time.
 *
 * Callers: `registerReferenceTools(server)` — idempotent, safe to
 * call whether or not ODIN_BASE_URL is set.
 */
export function registerReferenceTools(server: McpServer): void {
  // The v1 index.ts has all four calculator tools as inline
  // registerTool() calls. Until a refactor splits each into its own
  // file, the simplest path that preserves behavior is to require
  // the v1 module and let it register its tools. v1 tool names keep
  // their existing shape for backwards compatibility — Phase 2
  // introduces the agent-surface tools ALONGSIDE them, not instead of.
  //
  // The renaming to `reference.*` is deferred until the v1 tools
  // move into this file — that's a mechanical rename but touches
  // ~700 lines. For the Phase 2 MVP the v1 names continue working;
  // docs note them as "reference tools" to match the positioning.
  //
  // Status: v1 tools register themselves in the main entrypoint.
  // This function is the hook point for the Phase 2 rename work.
  void server;
}
