---
name: reset
description: Reset the current worktree to origin/main, remove stale worktree state, and reinstall project dependencies.
disable-model-invocation: true
allowed-tools: Bash, AskUserQuestion, TaskCreate, TaskList, TaskGet, TaskUpdate, TaskStop, TaskOutput, Monitor, Agent, SendMessage, CronList, CronDelete, mcp__watch-pr__unwatch_pr
---

# Reset worktree to origin/main

Reset the current worktree to `origin/main` and leave the session ready for a clean
start. The deterministic repository and dependency work is implemented by the sibling
`reset.py` script. Do not duplicate that work manually.

## Harness instructions

Read exactly one sibling instruction file before running the script. Detect the harness from
the current system context; if `omp://` is mentioned, the harness is Oh My Pi:

- Oh My Pi when `omp://` is present: `omp.md`
- Claude Code: `claude.md`
- Codex: `codex.md`
- OpenCode: `opencode.md`

Follow that file's harness-specific teardown and confirmation rules. The harness files
contain no repository commands; `reset.py` is the only reset implementation.

## Shared watch-pr cleanup

Before running the reset script, stop every watch-pr watcher started by the current
session and confirm its process or subagent has ended. Only then call the watch-pr MCP
tool `unwatch_pr` for each corresponding pull request. Do not cancel durable watches
owned by another session. The selected harness file defines which controls stop and
verify its Monitor, subagent, or async job; it does not change this ordering or scope.

## Arguments

- `--force` discards tracked, untracked, ignored, and repository-wide stashed changes
  without confirmation, deletes stale local branches, removes every linked worktree when
  run from the primary worktree, and warns before removing linked worktrees with
  uncommitted changes or detached links whose commits may become unreachable. It resets
  `main` there to `origin/main`. It refuses linked-worktree invocations because
  `--force` would delete every linked worktree; do not relocate and rerun it without
  confirming that destructive scope with the user. It also refuses bare repositories
  without a primary worktree or removal while a Git operation is active in a linked
  worktree. In force mode it synchronizes submodules recursively and fails if the root
  worktree or any submodule remains dirty or out of sync.
- `--confirm` removes the reviewed untracked files after the user approves the list
  reported by the normal safety phase.
- `--all` updates every linked worktree in normal mode.

In normal mode, the script protects tracked changes and records the exact untracked-file
snapshot before it reports the paths. Never run `--confirm` without explicit affirmative
approval of that complete report. `--force` bypasses normal confirmation and discards the
tracked, untracked, ignored, and stashed changes described above.

## Run

Invoke the sibling script by its absolute path. Do not search for a second installation:

```text
python "<absolute path of the directory containing this SKILL.md>/reset.py" [arguments]
```

The script owns the complete repository flow: stale-lock handling, unfinished-operation
cleanup, safety checks, untracked-file cleanup, stash handling, remote synchronization,
worktree pruning, linked-worktree removal or synchronization, stale-branch cleanup, branch
reset, recursive submodule synchronization, final cleanliness verification, and dependency
installation.

Report the script output and final status when it completes. Include the agent-state
validation required by the selected harness instruction file.
