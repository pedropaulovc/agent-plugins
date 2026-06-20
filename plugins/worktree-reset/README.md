# worktree-reset plugin

Provides the `/m` skill: tears down in-flight agent state (task list, scheduled timers, teammates, subagents, monitors, loops, background jobs, PR activity subscriptions) and positively validates each list is empty, aborts any in-progress git operation (rebase/merge/cherry-pick/am) and stale lock, resets the current worktree branch to origin/main, cleans stale branches, prunes stale worktrees, removes untracked files (with confirmation), reports any stashes, and runs `npm install` on all worktrees.

Pass `--force` (`/m --force`) to discard everything — agent state, uncommitted, untracked, git-ignored files (`git clean -fdx .`), and stashes (`git stash clear`) — without asking.
