# O.D.I.N. Skill packages

Agent behavior packages for [Claude Code](https://docs.claude.com/claude-code), [OpenClaw](https://github.com/openclaw/openclaw), [Cline](https://github.com/cline/cline), [Continue](https://continue.dev), and any other MCP client that supports the `SKILL.md` format.

A Skill tells the agent **how to drive O.D.I.N. safely** — dry-run-first, one action per turn, branch on structured error codes, never batch cancellations. It's the prompt that turns a raw 32B local model into a reliable farm operator.

## Packages

### `odin-farm/` — Farm Operator

The baseline skill for driving a live farm. Covers status checks, queue management, printer control, inventory, alerts, and maintenance. Enforces the retry-safety rules that pair with the backend's idempotency/dry-run primitives.

## Install

### Claude Code

```bash
mkdir -p ~/.claude/skills
cp -r odin-farm ~/.claude/skills/
```

Claude Code auto-loads every `SKILL.md` under `~/.claude/skills/` on launch.

### OpenClaw / Cline

Same layout. Check your client's skill / prompt-pack docs for the exact location (usually `~/.openclaw/skills/` or configurable in settings).

### Continue (VS Code)

Paste the `SKILL.md` body into `~/.continue/system-prompt.md` or a custom rule. Continue treats it as a persistent system message on every session.

## Writing your own

Operators often have house-specific rules ("always queue PLA jobs on printers 1–4, never on 5–8"). Fork `odin-farm/SKILL.md`, add your rules under a new section, save as `odin-farm-$yourshop/SKILL.md`. The MCP server is the same; only the operator prompt changes.

## Why this matters

Without a skill, a local 32B model will happily call `cancel_job` without confirming which job, chain three writes without pausing, or retry a `validation_failed` forever. The baseline skill rules out those failure modes by making the agent:

1. Read before it writes.
2. Dry-run before it commits.
3. Branch on `error.code` instead of retrying blindly.
4. Surface quota / scope / permission errors to the user verbatim.

These four rules eliminate ~90% of "helpful agent destroys the queue" incidents.
