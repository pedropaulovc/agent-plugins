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

For untracked-file approval, use `AskUserQuestion` to show the complete report and obtain
an explicit affirmative response. Do not infer approval from path classification.
