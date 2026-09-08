# worktree-reset plugin

Provides the explicit `/reset` skill (`$reset` in Codex). This is a breaking rename from
the former `/m` and `$m` entry points; no compatibility alias remains. Harness-specific
agent-state teardown lives in sibling instruction files, and the shared `reset.py`
implementation owns the complete repository flow and dependency installation.

Arguments:

- `--confirm` removes the reviewed untracked files after the user approves the safety
  report.
- `--force` discards tracked, untracked, ignored, and repository-wide stashed changes
  without confirmation, deletes stale local branches, removes every linked worktree when
  run from the primary worktree, and warns before removing linked worktrees with
  uncommitted changes or detached links whose commits may become unreachable. It resets
  `main` there to `origin/main`. It refuses linked-worktree invocations because rerunning
  from the primary would delete every linked worktree, refuses bare repositories without a
  primary worktree, and refuses removal while a Git operation is active in a linked
  worktree.
- `--all` updates every linked worktree in normal mode.

The script handles stale locks, unfinished operations, safety checks, untracked-file cleanup,
stash handling, linked-worktree removal or synchronization, remote synchronization, stale
branches, branch resets, and `npm install`, `go mod download`, and `uv sync --locked` when
the corresponding files exist.

## Harness support

Shared reset safety, arguments, and script-invocation rules live in `SKILL.md`; sibling
files only describe harness-specific teardown and user-interaction APIs. Claude Code reads
`claude.md`. If the current system context mentions `omp://`, Oh My Pi is running and reads
`omp.md` instead. Codex and OpenCode read their respective files and skip Claude-only
state tools while handling background terminals through their own harness mechanisms.
