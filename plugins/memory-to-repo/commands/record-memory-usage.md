---
description: Scan past sessions (including worktrees) for memory files actually Read, and refresh memory/usage.jsonl so SessionStart can rank memories by usage
allowed-tools: Bash
---

# Record memory usage

Run the usage scanner and report what it found:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/record-memory-usage.ts" 2>&1`

## What this does

Scans every past Claude Code session for this project — the main checkout
and any sessions run in a `.claude/worktrees/*` worktree of it — for `Read`
tool calls whose target file resolved to `memory/<name>.md` (excluding the
`MEMORY.md` index itself). For each distinct `(sessionId, memoryFileName)`
pair found, it writes one JSON line to `memory/usage.jsonl`:

```json
{"sessionId": "025df9d0-...", "memoryFileName": "memory/gstack-entrepreneur-vendoring.md"}
```

The file is fully regenerated each run (not appended to), so it stays
correct if a memory file was renamed or removed. The `SessionStart` hook
(`hooks/session-start.sh`) reads it, if present, to sort the `MEMORY.md`
index by how many distinct sessions have actually consulted each memory —
most-used first — and includes the **full index line** (title + description)
for the top 5, while the rest still get title-only, as before.

Re-run this command periodically (there's no automatic trigger) to keep
`usage.jsonl` in sync with recent sessions. Report the summary line the
script prints; if it changed `memory/usage.jsonl`, remind the user it's a
tracked file and should be committed like any other memory change.
