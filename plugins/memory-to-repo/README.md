# memory-to-repo plugin

Two hooks that move Claude Code's auto memory off the **machine-local auto-memory directory** (`~/.claude/projects/<slug>/memory/`) and onto the **repository's `./memory/` folder** — so accumulated memory is git-tracked and shared across every user, machine, and cloud session:

- a `PreToolUse` hook that blocks CRUD on the machine-local directory and redirects the agent to make the **exact same change** under `./memory/` instead;
- a `SessionStart` hook that, at the start of every session, tells the agent to use `./memory/` as the auto-memory destination and injects the repo's `./memory/MEMORY.md` index up front — mirroring how Claude Code normally surfaces the auto-memory `MEMORY.md`, but from the version-controlled location.

## Why

[Auto memory](https://code.claude.com/docs/en/memory) lets Claude accumulate learnings across sessions by reading and writing `MEMORY.md` and topic files. But that directory is **machine-local**: it isn't tracked in git and isn't shared across users, machines, or cloud sessions. Knowledge Claude saves there is invisible to your teammates and lost on a fresh checkout.

This hook converts every memory operation into a hard block with guidance to perform the identical operation against a committed `./memory/` folder in the repo, turning per-machine notes into version-controlled, shareable project knowledge.

## Behavior

The hook matches the tools Claude uses to manipulate memory files — `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Read`, `Grep`, `Glob`, `ListDir`, and `Bash` — and inspects the **target path** (Claude reads/writes auto memory with its standard file tools; there is no dedicated "memory" tool). It decodes JSON string escapes first, so a double-quoted path inside a `Bash` command (`rm "~/.claude/.../memory/x.md"`) is matched rather than truncated. Shell deletes/renames — including PowerShell `Remove-Item`/`Move-Item` — run through the `Bash` tool and are matched path-agnostically; there is no separate PowerShell tool. If the path resolves to `~/.claude/projects/<slug>/memory/` (POSIX or Windows backslash form), it returns a `deny` decision instructing the agent to:

- **Create / Update** → write the same file under `./memory/` with identical content (e.g. `./memory/MEMORY.md`, `./memory/debugging.md`)
- **Read** → read the corresponding file under `./memory/` instead
- **Delete / Rename** → do it under `./memory/`

`./memory/MEMORY.md` is kept as the index, mirroring the auto-memory layout, so the redirected structure matches what Claude already expects.

### SessionStart injection

At session start (including resume, clear, and compact) the `SessionStart` hook emits a `<system-reminder>` instructing the agent to ignore the default auto-memory destination and use `<project>/memory` instead. When `<project>/memory/MEMORY.md` exists, its contents are appended verbatim under a `Contents of …/MEMORY.md (project's auto-memory, persists across conversations)` header — so the index is in context from the first turn, loaded from the shared repo folder rather than the machine-local one. The project root is taken from `$CLAUDE_PROJECT_DIR` (falling back to the working directory).

Only the path-bearing fields (`file_path`, `path`, `command`) are inspected — **file content is never scanned**, so writing documentation that merely *mentions* the auto-memory path is not blocked. The `transcript_path` field (which lives under the same `projects/` directory but has no `memory` segment) is also left untouched.

## Limitation: custom memory locations

The hook anchors to the **default** auto-memory location, `~/.claude/projects/<slug>/memory/`. If you relocate auto memory with the [`autoMemoryDirectory`](https://code.claude.com/docs/en/memory) setting (e.g. `~/my-memory-dir`), that path is **not** auto-detected. This is deliberate: matching a bare `.../memory` segment anywhere would also block the repo's own `./memory/` folder — the very target this hook redirects to. To cover a relocated store, extend the regex in `hooks/memory-to-repo.sh` to include that path.

## Escape hatch

If a note is genuinely machine-specific, secret, or otherwise must **not** be shared, add `[force-memory]` to the call's main string field — the `Bash` `command`, or the `file_path` for a file tool — to bypass the block. The hook strips the marker from the request before the operation runs, so it never lands in an executed command or a written path. This is reserved for the rare non-shareable case — not a routine way to skip the redirect.

## Note

Claude Code loads `MEMORY.md` at session start and the `/memory` command operate internally, not through tool calls, so this hook does not interfere with them — it only governs the agent's own tool-driven reads and writes.

## License

MIT
