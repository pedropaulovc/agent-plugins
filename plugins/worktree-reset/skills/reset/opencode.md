# OpenCode instructions

OpenCode does not provide Claude Code task-list, timer, teammate, subagent, monitor, loop,
or pull-request subscription tools. Skip those operations. Stop active background terminals
through the OpenCode harness mechanism and confirm that no background jobs remain.

In normal mode, the reset script stops before removing untracked files. Inspect the paths
and ask the user whether uncertain files may be removed. After approval, rerun the script
with the original arguments plus `--confirm`. In `--force` mode, skip worktree and stash
confirmation: the script discards tracked, untracked, ignored, and repository-wide
stashed changes.

Do not run cleanup commands by hand. The `/reset` command forwards its arguments to the
sibling `reset.py`; report the script output and final status.
