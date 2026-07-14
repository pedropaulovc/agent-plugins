# memory-to-repo plugin

Two hooks that move Claude Code and Codex memory off their **machine-local directories** (`~/.claude/projects/<slug>/memory/` and `~/.codex/memories/`) and onto the **repository's `./memory/` folder** — so accumulated memory is git-tracked and shared across every user, machine, and cloud session:

- a `PreToolUse` hook that blocks CRUD on the machine-local directory and redirects the agent to make the **exact same change** under `./memory/` instead;
- a `SessionStart` hook that, at the start of every session, tells the agent to use `./memory/` as the auto-memory destination and surfaces the repo's `./memory/MEMORY.md` index up front — the leading entries with their full one-line **descriptions** and the rest as bare titles, budgeted to keep context lean, mirroring how Claude Code normally surfaces the auto-memory `MEMORY.md`, but from the version-controlled location. When `./memory/usage.jsonl` is present, the index is instead sorted by how often each memory has actually been consulted (see [below](#record-memory-usage-command)).

It also ships a `/memory-audit` command that audits the store for staleness (see [below](#memory-audit-command)), and a `/record-memory-usage` command that tracks which memories get used (see [below](#record-memory-usage-command)).

## Why

[Auto memory](https://code.claude.com/docs/en/memory) lets Claude accumulate learnings across sessions by reading and writing `MEMORY.md` and topic files. But that directory is **machine-local**: it isn't tracked in git and isn't shared across users, machines, or cloud sessions. Knowledge Claude saves there is invisible to your teammates and lost on a fresh checkout.

This hook converts every memory operation into a hard block with guidance to perform the identical operation against a committed `./memory/` folder in the repo, turning per-machine notes into version-controlled, shareable project knowledge.

## Behavior

The hook matches the tools the harnesses use to manipulate memory files — `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Read`, `Grep`, `Glob`, `ListDir`, and `Bash` — and inspects the **target path** (there is no dedicated "memory" tool). JSON input is parsed natively, so quoted paths are handled without shell escaping ambiguities. Shell deletes/renames — including PowerShell `Remove-Item`/`Move-Item` — are matched path-agnostically. If the path resolves to `~/.claude/projects/<slug>/memory/` or `~/.codex/memories/` (POSIX or Windows backslash form), it returns a `deny` decision instructing the agent to:

- **Create / Update** → write the same file under `./memory/` with identical content (e.g. `./memory/MEMORY.md`, `./memory/debugging.md`)
- **Read** → read the corresponding file under `./memory/` instead
- **Delete / Rename** → do it under `./memory/`

`./memory/MEMORY.md` is kept as the index, mirroring the auto-memory layout, so the redirected structure matches what Claude already expects.

### SessionStart injection

At session start (including resume, clear, and compact) the `SessionStart` hook emits a `<system-reminder>` instructing the agent to ignore the default auto-memory destination and use `<project>/memory` instead. When `<project>/memory/MEMORY.md` exists, its index is appended — the leading entries keep their full line (`- [Title](file.md) — description`) and, once the description budget is spent, the rest fall back to `- Title`, so the descriptions are in context from the first turn without a large store bloating it. The reminder points the agent at `MEMORY.md` to read the complete contents on demand. The project root is taken from `$CLAUDE_PROJECT_DIR`, falling back to the nearest ancestor containing `.git` and then the working directory.

If `<project>/memory/usage.jsonl` exists and is non-empty, the only thing that changes is ordering: the index is sorted **descending by usage** (how many distinct past sessions actually consulted that memory file — see [`/record-memory-usage`](#record-memory-usage-command)) before the same budgeting runs, so the most-used memories are the ones that land in the full-description slots. Ties (including the common all-zero case before `usage.jsonl` has meaningful data) keep `MEMORY.md`'s original order.

Either way, if `usage.jsonl` is missing or its last update was more than a day ago, the reminder also appends a one-line nudge to run [`/record-memory-usage`](#record-memory-usage-command), so the ranking doesn't silently go stale (there's no automatic trigger for that command). Freshness is judged by the file's mtime, which the command bumps each time it appends.

Both branches — the usage-sorted one above and the original-order one used when `usage.jsonl` is absent — stay under Claude Code's [10,000-character `additionalContext` cap](https://code.claude.com/docs/en/hooks) by construction, rather than relying on the harness's own truncation (which swaps overflow content for a file preview + path, not a clean cut, and could sever a memory entry mid-line). The hook computes a live budget (`10,000 − 1,500-char safety margin − length of the fixed reminder text`) each run — mirroring the same idea behind auto memory's own `MEMORY.md` cutoff (first 200 lines or 25KB, whichever comes first): a fixed, predictable budget instead of an after-the-fact truncation. Within that budget:

- The first 3 memories (in whatever order the branch produced) always get a full index line; if one doesn't fit its share of the description budget (30% of the total), it's ellipsis-truncated rather than dropped to title-only.
- Beyond the first 3, a memory gets its full description only while the description budget lasts; once spent, remaining memories fall back to title-only, spending whatever the description budget didn't use.
- If even title-only lines overrun what's left, the rest are omitted, and a trailing `…and N more memories omitted` line reports the count — so a large store degrades to a shorter, still-useful list instead of silently losing its tail to the hook's own truncation.

Only the path-bearing fields (`file_path`, `path`, `command`) are inspected — **file content is never scanned**, so writing documentation that merely *mentions* the auto-memory path is not blocked. The `transcript_path` field (which lives under the same `projects/` directory but has no `memory` segment) is also left untouched.

## Limitation: custom memory locations

The hook anchors to the **default** machine-local locations. If you relocate Claude auto memory with [`autoMemoryDirectory`](https://code.claude.com/docs/en/memory), or relocate Codex with `CODEX_HOME`, that path is **not** auto-detected. This is deliberate: matching a bare `.../memory` segment anywhere would also block the repo's own `./memory/` folder — the very target this hook redirects to. To cover a relocated store, extend `targets_machine_local_memory` in `hooks/memory-to-repo/src/main.rs`.

## Native cross-platform hook

Both lifecycle events are implemented by one Rust program and shipped as prebuilt Linux x86_64 and Windows x86_64 binaries under `hooks/bin/`. Claude Code and Codex therefore execute the same logic on both operating systems without requiring `sh`, `jq`, PowerShell, Python, or Node on the hook process `PATH`.

After changing the Rust source or plugin version, rebuild both binaries from the repository root:

```text
python plugins/memory-to-repo/hooks/build-hooks.py
```

Run the source-level protocol tests with `cargo test -p memory-to-repo`.

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

`/record-memory-usage` runs `scripts/record-memory-usage.ts` over past Claude Code JSONL transcripts and Codex JSONL rollouts (`~/.codex/sessions/`, or `$CODEX_HOME/sessions`). It includes sessions from every checkout reported by `git worktree list` and normalizes each read against that checkout root, so worktrees and the main checkout all resolve to the same `memory/<file>.md` name. The Claude parser uses [`claude-code-types`](https://www.npmjs.com/package/claude-code-types) for transcript types.

It counts a memory file as consulted when a `Read` tool call, or a file-reading **shell command** (`cat`, `sed`, `rg`, `Get-Content`, …, in Claude Code's `Bash` or a Codex shell call), targets a file under `memory/` — excluding the `MEMORY.md` index. Codex has no Read tool, so its reads are seen only as shell commands. To keep the ranking meaningful, a memory path that appears in a **write or VCS command** instead — `git add memory/x.md`, `git rm memory/x.md`, `rm memory/x.md`, `mv`, an output redirection (`> memory/x.md`), or an `apply_patch` — is deliberately **not** counted: committing or deleting a memory isn't reading it. For each qualifying read it records one `{sessionId, memoryFileName}` pair, deduplicated per session, and appends any not already present to `./memory/usage.jsonl` — one JSON object per line. Existing lines are kept byte-for-byte and never reordered; only new records are added at the end. Since `usage.jsonl` is git-tracked and shared, this keeps concurrent runs (different people, different branches) append-only at the tail, which git merges cleanly — a full rewrite/re-sort would touch nearly every line and turn every concurrent run into a merge conflict. The trade-off: a record for a memory file that's later renamed or deleted just goes unused rather than being cleaned up (the ranking below simply never looks it up).

The first time `./memory/usage.jsonl` is created, the script also adds `memory/usage.jsonl merge=union` to the project's `.gitattributes` (creating it if absent), so git auto-resolves any conflicting append with the built-in `union` merge driver instead of leaving conflict markers — a leftover marker would otherwise corrupt every line downstream readers parse. This only runs on that first creation, not on every invocation, so the script's side effects stay limited to a one-time setup step.

```
/record-memory-usage
```

Runs via plain `node` (native TypeScript type-stripping, Node ≥23.6 — no build step and no install required at runtime, since the imported types are erased before execution). The `SessionStart` hook then reads `usage.jsonl`, if present, to rank the index — see [SessionStart injection](#sessionstart-injection) above. There's no automatic trigger for this command; re-run it periodically to keep the ranking fresh, and commit `memory/usage.jsonl` like any other memory file.

## Note

Claude Code loads `MEMORY.md` at session start and the `/memory` command operate internally, not through tool calls, so this hook does not interfere with them — it only governs the agent's own tool-driven reads and writes.

## License

MIT

## Codex support

Works in Claude Code and Codex on Windows and Linux. Redirects each harness's machine-local auto-memory to the repo `./memory/` store — `~/.claude/projects/<slug>/memory/` under Claude Code and `~/.codex/memories/` under Codex. The `[force-memory]` escape hatch auto-approves under Codex only in `bypassPermissions`/`dontAsk` modes; otherwise it defers to the normal approval prompt.

`/memory-audit` and `/record-memory-usage` are registered as Codex commands. The usage scanner covers Claude Code Read/`Bash` history plus Codex JSONL rollouts (whose file reads are shell commands, since Codex has no Read tool).
