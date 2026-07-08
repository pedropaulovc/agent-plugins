# memory-to-repo plugin

Two hooks that move Claude Code's auto memory off the **machine-local auto-memory directory** (`~/.claude/projects/<slug>/memory/`) and onto the **repository's `./memory/` folder** — so accumulated memory is git-tracked and shared across every user, machine, and cloud session:

- a `PreToolUse` hook that blocks CRUD on the machine-local directory and redirects the agent to make the **exact same change** under `./memory/` instead;
- a `SessionStart` hook that, at the start of every session, tells the agent to use `./memory/` as the auto-memory destination and surfaces the repo's `./memory/MEMORY.md` index up front — emitting just the memory **titles** (not the full one-line descriptions) to keep context lean, mirroring how Claude Code normally surfaces the auto-memory `MEMORY.md`, but from the version-controlled location. When `./memory/usage.jsonl` is present, the index is instead sorted by how often each memory has actually been consulted (see [below](#record-memory-usage-command)).

It also ships a `/memory-audit` command that audits the store for staleness (see [below](#memory-audit-command)), and a `/record-memory-usage` command that tracks which memories get used (see [below](#record-memory-usage-command)).

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

At session start (including resume, clear, and compact) the `SessionStart` hook emits a `<system-reminder>` instructing the agent to ignore the default auto-memory destination and use `<project>/memory` instead. When `<project>/memory/MEMORY.md` exists, only the memory **titles** are appended — each index line (`- [Title](file.md) — description`) is reduced to `- Title`, so the index is in context from the first turn without the full descriptions bloating it. The reminder points the agent at `MEMORY.md` to read the complete contents on demand. The project root is taken from `$CLAUDE_PROJECT_DIR` (falling back to the working directory).

If `<project>/memory/usage.jsonl` exists and is non-empty, this changes: the index is sorted **descending by usage** (how many distinct past sessions actually `Read` that memory file — see [`/record-memory-usage`](#record-memory-usage-command)), and the **top 5** get their full index line (title + description) instead of just the title, since those are the memories most worth having in full up front. Ties (including the common all-zero case before `usage.jsonl` has meaningful data) keep `MEMORY.md`'s original order. Everything past the top 5 still gets title-only, same as when `usage.jsonl` is absent.

Only the path-bearing fields (`file_path`, `path`, `command`) are inspected — **file content is never scanned**, so writing documentation that merely *mentions* the auto-memory path is not blocked. The `transcript_path` field (which lives under the same `projects/` directory but has no `memory` segment) is also left untouched.

## Limitation: custom memory locations

The hook anchors to the **default** auto-memory location, `~/.claude/projects/<slug>/memory/`. If you relocate auto memory with the [`autoMemoryDirectory`](https://code.claude.com/docs/en/memory) setting (e.g. `~/my-memory-dir`), that path is **not** auto-detected. This is deliberate: matching a bare `.../memory` segment anywhere would also block the repo's own `./memory/` folder — the very target this hook redirects to. To cover a relocated store, extend the regex in `hooks/memory-to-repo.sh` to include that path.

## Escape hatch

If a note is genuinely machine-specific, secret, or otherwise must **not** be shared, add `[force-memory]` to the call's main string field — the `Bash` `command`, or the `file_path` for a file tool — to bypass the block. The hook strips the marker from the request before the operation runs, so it never lands in an executed command or a written path. This is reserved for the rare non-shareable case — not a routine way to skip the redirect.

## `/memory-audit` command

Over time, memories drift: a note references a function that was renamed, a "we always do X" decision that was later reversed, or a relative date ("changed the key yesterday") with no anchor. `/memory-audit` audits the `./memory/` store for exactly that kind of staleness.

It fans out **one read-only [`Explore`](https://code.claude.com/docs/en/sub-agents) subagent per memory file, on Haiku**, in parallel. Each subagent reads its assigned memory, extracts the concrete claims (file paths, symbols, flags, decisions, dates, `[[links]]`), then checks them against the **current repo state** (does the thing still exist / behave as described?) and **git history** (`git log`/`git blame` — was it renamed, moved, removed, or reversed?). Because the evaluators are `Explore` agents they can read and run `git` but cannot `Edit`/`Write`, so they can never mutate a memory while judging it.

Each returns a verdict — `FRESH` / `STALE` / `CONTRADICTED` / `UNVERIFIABLE` — with evidence (the file line or commit SHA that proves the problem). The findings bubble back up to the **main agent**, which decides per memory — and **when in doubt, raises it to you rather than editing silently**:

- **Amend** in place — only **mechanical, objective** fixes: convert relative dates to absolute, fix a plainly renamed/moved reference. Facts are **superseded, never silently deleted**.
- **Raise for confirmation** — every `CONTRADICTED` finding and any important-looking `UNVERIFIABLE` claim. A contradiction is ambiguous: the memory may be out of date, *or* the code may have drifted from a recorded decision/preference. Rewriting it to "the new truth" would launder a regression into remembered fact, so the command presents the evidence and lets you choose: update the memory, fix the code, or keep it as-is.
- **Drop** — only after confirming with you, since deleting a committed memory removes shared knowledge for the whole team.
- **Keep** — `FRESH` (and unconfirmed `UNVERIFIABLE`) memories are left alone.

It then re-syncs `MEMORY.md` so the index matches the files on disk, and reports a summary table of what it changed versus what it raised for you to decide.

```
/memory-audit                       # audit every memory
/memory-audit memory/decisions.md   # audit specific file(s) or globs
```

## `/record-memory-usage` command

`/record-memory-usage` runs `scripts/record-memory-usage.ts` — a Node script using the [`claude-code-types`](https://www.npmjs.com/package/claude-code-types) package's type definitions for Claude Code's JSONL transcript format — over every past session for this project, **including sessions run in a `.claude/worktrees/*` worktree** of it (worktree sessions get their own `~/.claude/projects/<slug>--claude-worktrees-<name>/` directory; the script finds them by slug prefix and normalizes each `Read`'s absolute path against that session's own `cwd`, so a worktree checkout and the main checkout both resolve to the same `memory/<file>.md` name).

For every `Read` tool call in those transcripts whose target resolved to a file under `memory/` (excluding the `MEMORY.md` index itself), it records one `{sessionId, memoryFileName}` pair, deduplicated per session, and appends any not already present to `./memory/usage.jsonl` — one JSON object per line. Existing lines are kept byte-for-byte and never reordered; only new records are added at the end. Since `usage.jsonl` is git-tracked and shared, this keeps concurrent runs (different people, different branches) append-only at the tail, which git merges cleanly — a full rewrite/re-sort would touch nearly every line and turn every concurrent run into a merge conflict. The trade-off: a record for a memory file that's later renamed or deleted just goes unused rather than being cleaned up (the ranking below simply never looks it up).

The first time `./memory/usage.jsonl` is created, the script also adds `memory/usage.jsonl merge=union` to the project's `.gitattributes` (creating it if absent), so git auto-resolves any conflicting append with the built-in `union` merge driver instead of leaving conflict markers — a leftover marker would otherwise corrupt every line downstream readers parse. This only runs on that first creation, not on every invocation, so the script's side effects stay limited to a one-time setup step.

```
/record-memory-usage
```

Runs via plain `node` (native TypeScript type-stripping, Node ≥23.6 — no build step and no install required at runtime, since the imported types are erased before execution). The `SessionStart` hook then reads `usage.jsonl`, if present, to rank the index — see [SessionStart injection](#sessionstart-injection) above. There's no automatic trigger for this command; re-run it periodically to keep the ranking fresh, and commit `memory/usage.jsonl` like any other memory file.

## Note

Claude Code loads `MEMORY.md` at session start and the `/memory` command operate internally, not through tool calls, so this hook does not interfere with them — it only governs the agent's own tool-driven reads and writes.

## License

MIT
