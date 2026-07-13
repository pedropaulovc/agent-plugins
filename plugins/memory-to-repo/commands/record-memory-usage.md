---
description: Scan past sessions (including worktrees) for memory files actually Read, and refresh memory/usage.jsonl so SessionStart can rank memories by usage
allowed-tools: Bash
---

# Record memory usage

Run the usage scanner and report what it found:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/record-memory-usage.ts" 2>&1`

## What this does

Scans past Claude Code JSONL transcripts and OpenCode's SQLite session database
for this project across every checkout reported by `git worktree list`. It
finds read-tool calls whose target resolved to `memory/<name>.md` (excluding the
`MEMORY.md` index itself). For each distinct `(sessionId, memoryFileName)` pair
found, it writes one JSON line to `memory/usage.jsonl`:

```json
{"sessionId": "025df9d0-...", "memoryFileName": "memory/gstack-entrepreneur-vendoring.md"}
```

Existing lines are preserved byte-for-byte and never reordered — only
genuinely new records are appended at the end. `usage.jsonl` is git-tracked
and shared, so two people (or two branches) running this command
independently should each only add lines at the tail, which git merges
cleanly; a full rewrite/re-sort would touch nearly every line and turn every
concurrent run into a merge conflict. One consequence: a record for a memory
file that was later renamed or deleted just sits there unused (it's simply
never looked up by the ranking below) rather than being cleaned up — that's
the deliberate trade-off for merge-friendliness. The native `SessionStart` hook
(`hooks/memory-to-repo/src/main.rs`) reads it, if present, to sort the `MEMORY.md`
index by how many distinct sessions have actually consulted each memory —
most-used first — and includes the **full index line** (title + description)
for the top 5, while the rest still get title-only, as before.

Re-run this command periodically (there's no automatic trigger) to keep
`usage.jsonl` in sync with recent sessions. Report the summary line the
script prints; if it changed `memory/usage.jsonl`, remind the user it's a
tracked file and should be committed like any other memory change.
