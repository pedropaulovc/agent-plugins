# OpenCode instructions

Before running the reset script, use the harness controls that are available in this
OpenCode installation:

- Stop any long-lived subagent or background terminal running `watch-pr-monitor.mjs` and
  confirm its process ended. For each PR watcher stopped in this session, call the
  watch-pr MCP tool `unwatch_pr` afterward. Do not remove unrelated durable watches owned
  by another session.
- Stop other active background terminals and subagents, then confirm no background work
  remains. Skip unsupported task-list, timer, teammate, or monitor operations rather than
  inventing equivalents.

Use the OpenCode user-interaction mechanism to show the complete untracked-file report and
obtain an explicit affirmative response before a confirmation rerun. Do not infer approval
from path classification.
