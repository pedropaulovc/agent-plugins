# Oh My Pi instructions

If the current system context mentions `omp://`, this is an Oh My Pi session. Use this
file instead of the Claude Code, Codex, or OpenCode instructions.

Oh My Pi exposes task and process controls through its harness tools. Before running the
reset script:

- Clear and re-read the task list with the harness todo controls.
- Inspect background jobs and active harness processes with the hub controls. Stop or
  cancel every active job/process, then query again and confirm none remain.
- Inspect the peer-agent roster when the harness exposes one, and stop or dismiss any
  active peer work before continuing.
- Do not invent Claude-only timers, monitor, loop, or pull-request subscription operations;
  skip them unless the current harness explicitly exposes an equivalent.

In normal mode, the reset script stops before removing untracked files. Inspect the paths
and ask the user whether uncertain files may be removed. After approval, rerun the script
with the original arguments plus `--confirm`. In `--force` mode, skip worktree and stash
confirmation: the script discards tracked, untracked, ignored, and repository-wide
stashed changes.

Do not run cleanup commands by hand. Invoke the sibling `reset.py`, forwarding the
arguments supplied to `/reset`, and report its output and final status, including the
validated task, job, process, and peer-agent state.
