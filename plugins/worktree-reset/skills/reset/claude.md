# Claude Code instructions

Claude Code owns the agent-state teardown for this harness. Clear each list, then query it
again and confirm it is empty before continuing. If a list still has entries, retry the
clear and report anything that cannot be cleared.

- Clear and re-read the task list.
- Cancel and re-list scheduled timers.
- Dismiss and re-list teammates.
- Stop and re-list running or background subagents.
- Use the Monitor list and stop controls for each `watch-pr-monitor.mjs` process
  covered by the shared watch-pr cleanup, then re-list Monitors to verify it ended.
- Stop background shell jobs and confirm the job list is empty.

For untracked-file approval, use `AskUserQuestion` to show the complete report and obtain
an explicit affirmative response. Do not infer approval from path classification.
