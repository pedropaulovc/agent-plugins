---
name: reset
description: Reset the current worktree to origin/main, remove stale worktree state, and reinstall project dependencies.
disable-model-invocation: true
allowed-tools: Bash, AskUserQuestion, TaskCreate, TaskList, TaskGet, TaskUpdate, TaskStop, TaskOutput, Monitor, Agent, SendMessage, CronList, CronDelete, unsubscribe_pr_activity
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

## Arguments

- `--force` discards tracked, untracked, ignored, and repository-wide stashed changes
  without confirmation.
- `--confirm` removes the reviewed untracked files after the user approves the list
  reported by the normal safety phase.
- `--all` also updates every other linked worktree.
- An optional folder name selects the branch associated with the current worktree; resetting
  that folder-named branch additionally requires `--force`.

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
worktree pruning, stale-branch cleanup, branch reset, linked-worktree updates, and
dependency installation.

Report the script output and final status when it completes. Include the agent-state
validation required by the selected harness instruction file.
