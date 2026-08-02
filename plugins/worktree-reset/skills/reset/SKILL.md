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

Read exactly one sibling instruction file before running the script:

- Claude Code: `claude.md`
- Codex: `codex.md`
- OpenCode: `opencode.md`

Follow that file's harness-specific teardown and confirmation rules. The harness files
contain no repository commands; `reset.py` is the only reset implementation.

## Arguments

- `--force` discards tracked, untracked, ignored, and repository-wide stashed changes
  without confirmation.
- `--clean` removes exactly the reviewed untracked paths supplied with `--clean-path`.
- `--clean-path PATH` names one reviewed untracked path; repeat it once per path with
  `--clean`.
- `--all` also updates every other linked worktree.
- An optional folder name selects the branch associated with the current worktree; resetting
  that folder-named branch additionally requires `--force`.

Forward every argument supplied to `/reset` or `$reset` to the script unchanged. If the
normal safety phase reports untracked files, preserve all original arguments and append
`--clean` plus one `--clean-path PATH` for each path the user approved.

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
