# worktree-reset plugin

Provides the `/m` skill: tears down in-flight agent state (task list, scheduled timers, teammates, subagents, monitors, loops, background jobs, PR activity subscriptions) and positively validates each list is empty, aborts any in-progress git operation (rebase/merge/cherry-pick/am) and stale lock, resets the current worktree branch to origin/main, cleans stale branches, prunes stale worktrees, removes untracked files (with confirmation), reports any stashes, and runs `npm install` on all worktrees.

## Codex and OpenCode support

Works in both. Explicit-only (`/m` or `$m`). Under Codex the agent-state teardown primitives (task list, monitors, timers, subagents, PR subscriptions) don't exist, so that section is skipped — the git reset + dependency reinstall is the portable core.

OpenCode exposes `/m` and follows the same portable fallback as Codex.
