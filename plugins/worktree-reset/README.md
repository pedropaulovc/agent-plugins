# worktree-reset plugin

Provides the `/m` skill: tears down in-flight agent state (task list, scheduled timers, teammates, subagents, monitors, loops, background jobs, PR activity subscriptions) and positively validates each list is empty — including an OS-level sweep that kills orphaned monitor/background-job pipelines left behind by a prior (pre-`/clear`) session. It then aborts any in-progress git operation (rebase/merge/cherry-pick/am) and stale lock, resets the current worktree branch to a base ref (default `origin/main`), cleans stale branches, prunes stale worktrees, removes untracked files (with confirmation), reports any stashes, and runs `npm install` on all worktrees.

All deterministic git and OS-level work lives in `skills/m/m.sh`; the prompt only handles harness-tool teardown and human judgment about un-discardable work.

## Flags

- `--force` (`/m --force`) — discard everything (agent state, uncommitted, untracked, git-ignored files via `git clean -fdx .`, and stashes via `git stash clear`) without asking.
- `--base <ref>` (`/m --base origin/release`) — reset onto `<ref>` instead of `origin/main`. Accepts any ref (branch, tag, SHA).
- `--all` — also rebase every other worktree onto the base.
