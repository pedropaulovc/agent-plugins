# Codex instructions

Codex has no equivalents for Claude Code task lists, scheduled timers, teammates,
subagents, monitor watchers, recurring loops, or pull-request activity subscriptions.
Do not attempt those operations. Stop any active background terminal through the Codex
harness mechanism and confirm the background-job list is empty.

In normal mode, the reset script stops before removing untracked files. Inspect the paths
and ask the user whether uncertain files may be removed. After approval, rerun the script
with the original arguments plus `--confirm`. In `--force` mode, skip worktree and stash
confirmation: the script discards tracked, untracked, ignored, and repository-wide
stashed changes.

Do not run cleanup commands by hand. Invoke the sibling `reset.py`, forwarding the
arguments supplied to `$reset`, and report its output and final status.
