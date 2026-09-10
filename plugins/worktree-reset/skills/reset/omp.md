# Oh My Pi instructions

If the current system context mentions `omp://`, this is an Oh My Pi session. Use this
file instead of the Claude Code, Codex, or OpenCode instructions.

Oh My Pi exposes task, peer, job, and process controls through its harness tools. Before
running the reset script:

- Clear and re-read the task list with the harness todo controls.
- Inspect async hub jobs. Cancel every job running `watch-pr-monitor.mjs` by its recorded
  job ID and confirm it ended. For each PR watcher canceled in this session, call the
  watch-pr MCP tool `unwatch_pr` after the job has ended. Do not remove unrelated durable
  watches owned by another session.
- Inspect all remaining background jobs and active harness processes with the hub
  controls. Stop or cancel each one, then query again and confirm none remain.
- Inspect the peer-agent roster, stop or dismiss active peer work, and confirm none
  remains before continuing.
- Do not invent Claude `Monitor` or Codex subagent operations; use the OMP hub controls
  described above.

Use the Oh My Pi question mechanism to show the complete untracked-file report and obtain
an explicit affirmative response before a confirmation rerun. Do not infer approval from
path classification.
