# Codex instructions

Codex owns its subagent and terminal teardown. Before running the reset script:

- Use the subagent controls to interrupt each `watch-pr-monitor.mjs` process covered by
  the shared watch-pr cleanup, wait for it to end, then close that subagent.
- Stop any other active subagents and background terminals through the Codex harness,
  then confirm that no background work remains.

Use the Codex user-interaction mechanism to show the complete untracked-file report and
obtain an explicit affirmative response before a confirmation rerun. Do not infer approval
from path classification.
