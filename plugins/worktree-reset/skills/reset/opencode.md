# OpenCode instructions

OpenCode does not provide Claude Code task-list, timer, teammate, subagent, monitor, loop,
or pull-request subscription tools. Skip those operations. Stop active background terminals
through the OpenCode harness mechanism and confirm that no background jobs remain.

In normal mode, inspect any untracked files reported by the reset script and ask the user
whether uncertain files may be removed. After the user approves reviewed untracked files,
rerun the script with `--clean`. In `--force` mode, skip worktree and stash confirmation:
the script discards tracked, untracked, ignored, and stashed changes.

Do not run cleanup commands by hand. The `/reset` command forwards its arguments to the
sibling `reset.py`; report the script output and final status.
