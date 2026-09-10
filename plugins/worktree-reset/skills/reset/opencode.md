# OpenCode instructions

Before running the reset script, use the harness controls that are available in this
OpenCode installation:

- Use the available subagent or background-terminal controls to stop each
  `watch-pr-monitor.mjs` process covered by the shared watch-pr cleanup and verify it
  ended.
- Stop other active background terminals and subagents, then confirm no background work
  remains. Skip unsupported task-list, timer, teammate, or monitor operations rather than
  inventing equivalents.

Use the OpenCode user-interaction mechanism to show the complete untracked-file report and
obtain an explicit affirmative response before a confirmation rerun. Do not infer approval
from path classification.
