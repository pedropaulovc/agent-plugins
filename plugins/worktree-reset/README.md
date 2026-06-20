# worktree-reset plugin

Provides the `/m` skill: tears down in-flight agent state (task list, scheduled timers, teammates, subagents, monitors, loops, background jobs) and positively validates each list is empty, resets the current worktree branch to origin/main, cleans stale branches, removes untracked files (with confirmation), and runs `npm install` on all worktrees.

Pass `--force` (`/m --force`) to discard everything — agent state, uncommitted, untracked, and git-ignored files (`git clean -fdx .`) — without asking.
