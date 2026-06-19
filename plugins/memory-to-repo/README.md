# memory-to-repo plugin

A `PreToolUse` hook that blocks CRUD operations on Claude Code's **machine-local auto-memory directory** (`~/.claude/projects/<slug>/memory/`) and redirects the agent to make the **exact same change in the repository's `./memory/` folder** instead — so accumulated memory is git-tracked and shared across every user, machine, and cloud session.

## Why

[Auto memory](https://code.claude.com/docs/en/memory) lets Claude accumulate learnings across sessions by reading and writing `MEMORY.md` and topic files. But that directory is **machine-local**: it isn't tracked in git and isn't shared across users, machines, or cloud sessions. Knowledge Claude saves there is invisible to your teammates and lost on a fresh checkout.

This hook converts every memory operation into a hard block with guidance to perform the identical operation against a committed `./memory/` folder in the repo, turning per-machine notes into version-controlled, shareable project knowledge.

## Behavior

The hook matches the tools Claude uses to manipulate memory files — `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Read`, and `Bash` — and inspects the **target path** (Claude reads/writes auto memory with its standard file tools; there is no dedicated "memory" tool). If the path resolves to `~/.claude/projects/<slug>/memory/` (POSIX or Windows backslash form, plus custom `autoMemoryDirectory` locations that keep a `.../memory` segment), it returns a `deny` decision instructing the agent to:

- **Create / Update** → write the same file under `./memory/` with identical content (e.g. `./memory/MEMORY.md`, `./memory/debugging.md`)
- **Read** → read the corresponding file under `./memory/` instead
- **Delete / Rename** → do it under `./memory/`

`./memory/MEMORY.md` is kept as the index, mirroring the auto-memory layout, so the redirected structure matches what Claude already expects.

Only the path-bearing fields (`file_path`, `path`, `command`) are inspected — **file content is never scanned**, so writing documentation that merely *mentions* the auto-memory path is not blocked. The `transcript_path` field (which lives under the same `projects/` directory but has no `memory` segment) is also left untouched.

## Escape hatch

If a note is genuinely machine-specific, secret, or otherwise must **not** be shared, add `[force-memory]` to the tool call to bypass the block. This is reserved for the rare non-shareable case — not a routine way to skip the redirect.

## Note

Claude Code loads `MEMORY.md` at session start and the `/memory` command operate internally, not through tool calls, so this hook does not interfere with them — it only governs the agent's own tool-driven reads and writes.

## License

MIT
