# Codex instructions

Codex owns its subagent and terminal teardown. Before running the reset script:

- Find every long-lived subagent running `watch-pr-monitor.mjs`. Send it an interrupt,
  wait for the watcher process to end, then close the subagent. For each PR watcher
  stopped in this session, call the watch-pr MCP tool `unwatch_pr` after the process has
  ended. Do not remove unrelated durable watches owned by another session.
- Stop any other active subagents and background terminals through the Codex harness,
  then confirm that no background work remains.

Use the Codex user-interaction mechanism to show the complete untracked-file report and
obtain an explicit affirmative response before a confirmation rerun. Do not infer approval
from path classification.
