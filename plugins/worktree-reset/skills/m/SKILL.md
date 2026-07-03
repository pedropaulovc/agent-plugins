---
name: m
description: Reset current worktree to a base ref (default origin/main). Tears down agent state (task list, scheduled timers, teammates, subagents, monitors, loops, background jobs), cleans stale branches, resets to the base, and runs npm install on all worktrees. Pass --force to discard everything without asking, --base <ref> to reset onto a ref other than origin/main.
disable-model-invocation: true
allowed-tools: Bash, AskUserQuestion, TaskCreate, TaskList, TaskGet, TaskUpdate, TaskStop, TaskOutput, Monitor, Agent, SendMessage, CronList, CronDelete, unsubscribe_pr_activity
---

# Reset worktree to a base ref

Reset the current worktree branch to a base ref (default `origin/main`) **and** tear down
all in-flight agent state so the session starts from a clean slate.

## Arguments

- `--force` — run the whole flow without stopping for confirmation. Discards agent state,
  uncommitted, untracked, **and** git-ignored files, and drops all stashes.
- `--base <ref>` — reset onto `<ref>` instead of `origin/main` (e.g. `--base origin/release`,
  `--base v2.1.0`, a SHA). Forwarded to `m.sh` verbatim.
- `--all` — also rebase every **other** worktree onto the base.

## What `m.sh` does (don't do these by hand)

The `m.sh` script that sits next to this `SKILL.md` performs **all** the deterministic git
and OS-level work, so you only need to run it once (step 3). It:

- runs an **OS-level process sweep** that kills orphaned monitor / background-job pipelines
  (bash/tail/sleep processes whose command line references a `…/tasks/<task-id>.output`
  file) — these survive a `/clear` under the previous session ID and are invisible to the
  harness task tooling, so this sweep is the authoritative teardown for them (Windows and
  POSIX handled);
- clears a stale `.git/index.lock` and aborts any in-progress rebase/merge/cherry-pick/am;
- `git fetch --prune`, deletes stale `: gone]` local branches, prunes stale worktrees;
- checks out the base's local branch and `git reset --hard`s it (and the folder branch, and
  every other worktree with `--all`) onto the base;
- in `--force` mode, `git clean -fdx .` + `git stash clear`;
- reinstalls dependencies (`npm install` / `go mod download`) in each worktree.

You still own the two things a script can't do: harness-tool teardown (step 1) and human
judgment about un-discardable work (step 2).

## 1. Tear down agent state (harness tools)

Gracefully stop everything the harness *can* see, so its notifications settle before the
reset. For each list below, clear it **then re-query and confirm it is actually empty** —
never assume the clear succeeded. If something still can't be cleared, report it rather than
continuing silently.

- **Task list**: clear the todo list, then re-read it and confirm zero items.
- **Scheduled timers**: cancel every scheduled check-in / `send_later` timer, confirm none remain.
- **Teammates**: dismiss any teammate agents, confirm the roster is empty.
- **Subagents**: `TaskStop` every running/background subagent, confirm none remain.
- **Monitors**: `TaskStop` any active `Monitor` watchers.
- **Loops**: cancel any recurring `/loop` tasks and background loops.
- **Background jobs**: kill any active background shell job.
- **PR activity subscriptions**: `unsubscribe_pr_activity` from every watched PR so the
  session stops waking on GitHub webhook events, confirm none remain.

> [!WARNING]
> **`TaskList` does not prove monitors, subagents, or background jobs are gone.** It shows
> only the shared todo list, and anything started **before a `/clear`** runs under the
> *previous* session ID — invisible to the current session's task tooling entirely. Those
> orphans are killed by `m.sh`'s OS-level process sweep in step 3, which is the real
> validation. Do the graceful `TaskStop` teardown here for what the harness *can* see; let
> `m.sh` backstop the rest.

## 2. Guard un-discardable work (skip entirely in `--force`)

- **Uncommitted changes**: run `git status`. If there are staged/unstaged changes, stop and
  tell the user to commit or stash first.
- **Untracked files**: for each untracked file, decide if it's throwaway (temp/build/test
  output) or possibly important work. If uncertain about any file, use `AskUserQuestion`.
  Delete the throwaway ones (`git clean -df` from the repo root) and only proceed once the
  rest are resolved. (`m.sh` only cleans untracked/ignored files in `--force` mode, so in the
  default flow this cleanup is yours.)
- **Stashes**: run `git stash list`. `git reset --hard` does not clear stashes — report any
  that exist and let the user decide.

## 3. Run the reset

Invoke `m.sh` from this skill's own directory. You already know that directory's absolute
path — it's where you loaded this file from — so invoke the script by that path directly. Do
**not** search for it with `find`; that scans all of `~/.claude` and can match a stale copy.
Forward whatever flags the user passed to `/m`:

```bash
bash "<absolute path of the directory containing this SKILL.md>/m.sh" [--force] [--base <ref>] [--all]
```

Report the final status to the user when complete, including confirmation that every
agent-state list in step 1 was validated empty.
