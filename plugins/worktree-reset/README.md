# worktree-reset plugin

Provides the explicit `/reset` skill (`$reset` in Codex). This is a breaking rename from
the former `/m` and `$m` entry points; no compatibility alias remains. Harness-specific
agent-state teardown lives in sibling instruction files, and the shared `reset.py`
implementation owns the complete repository flow and dependency installation.

Arguments:

- `--confirm` removes the reviewed untracked files after the user approves the safety
  report.
- `--force` discards tracked, untracked, ignored, and repository-wide stashed changes
  without confirmation.
- `--all` also updates every linked worktree.

The script handles stale locks, unfinished operations, safety checks, remote
synchronization, worktree pruning, stale branches, branch resets, linked-worktree
updates, stash reporting, and `npm install`, `go mod download`, and `uv sync --locked`
when the corresponding files exist.

## Harness support

Claude Code reads `claude.md` for agent-state teardown and confirmation rules. If the
current system context mentions `omp://`, Oh My Pi is running and reads `omp.md` instead.
Codex and OpenCode read their respective files and skip Claude-only state tools while
handling background terminals through their own harness mechanisms.
