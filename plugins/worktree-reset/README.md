# worktree-reset plugin

Provides the explicit `/reset` skill (`$reset` in Codex). Harness-specific agent-state
teardown lives in sibling instruction files; the shared `reset.py` implementation owns
the complete repository flow and dependency installation.

Arguments:

- `--clean` removes reviewed untracked files while preserving ignored files.
- `--force` discards tracked, untracked, ignored, and stashed changes without confirmation.
- `--all` also updates every linked worktree.

The script handles stale locks, unfinished operations, safety checks, remote
synchronization, worktree pruning, stale branches, branch resets, linked-worktree
updates, stash reporting, and `npm install`, `go mod download`, and `uv sync --locked`
when the corresponding files exist.

## Harness support

Claude Code reads `claude.md` for agent-state teardown and confirmation rules. Codex and
OpenCode read their respective files and skip Claude-only state tools while handling
background terminals through their own harness mechanisms.
