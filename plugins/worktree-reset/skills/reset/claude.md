# Claude Code instructions

Claude Code owns the agent-state teardown for this harness. Clear each list, then query it
again and confirm it is empty before continuing. If a list still has entries, retry the
clear and report anything that cannot be cleared.

- Clear and re-read the task list.
- Cancel and re-list scheduled timers.
- Dismiss and re-list teammates.
- Stop and re-list running or background subagents.
- Stop active monitor watchers and confirm none remain.
- Cancel recurring loops and confirm none remain.
- Stop background shell jobs and confirm the job list is empty.
- Unsubscribe from watched pull requests and confirm no subscriptions remain.

In normal mode, the reset script protects tracked changes and stops before removing
untracked files. Use `AskUserQuestion` when the files are not clearly disposable. After
approval, rerun the script with the original arguments plus `--clean` and one
`--clean-path PATH` for each approved path. In `--force` mode, do not ask for worktree or
stash confirmation: the script discards tracked, untracked, ignored, and repository-wide
stashed changes.

Do not run cleanup commands by hand. Invoke the sibling `reset.py`, forwarding the
arguments supplied to `/reset`, and report its output and final status.
