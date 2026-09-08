---
name: watch-pr
description: Watch a GitHub PR's full lifecycle through the hosted watch-pr MCP server, act on CI and rebase changes, and handle incoming review feedback until merge or closure.
argument-hint: "[pr-url-or-ref]"
---

# Watch a PR to green + merged

Use the hosted `watch-pr` MCP server. It keeps durable per-account subscriptions,
refreshes watched pull requests every minute, consumes GitHub webhooks, and pushes
resource-update notifications. Never launch `watch-pr.py`, create a polling loop,
or start a second watcher.

## Start watching

1. Resolve the pull request with `gh pr view`. If no argument was supplied, resolve
   the current branch:

   ```bash
   gh pr view --json number,url -q '"#\(.number) \(.url)"'
   ```

   For an explicit number, URL, or branch, pass it to `gh pr view`. Keep the full
   URL; its `/OWNER/REPOSITORY/pull/NUMBER` path supplies the MCP arguments without
   depending on the current checkout's remotes.

2. Call the hosted MCP server's `watch_pr` tool with:
   - `repository`: `OWNER/REPOSITORY`
   - `number`: the pull-request number

   The call registers a durable watch and subscribes the current MCP connection to
   `watch-pr://OWNER/REPOSITORY/pull/NUMBER`. Its default brief result includes the
   current lifecycle state when a snapshot already exists. `snapshot: refresh
   scheduled` means the initial GitHub refresh is in flight; wait for the resource
   update instead of polling.

3. On every resource-update or `watch-pr` log notification, call `get_pr` in its
   default brief mode and act on changed lines. Use `list_pr_events` only when event
   history helps explain a transition. Use `get_pr` with `mode: "full"` when bodies,
   thread IDs, URLs, or exact snapshot fields are needed.

## Act on lifecycle lines

| Line | Action |
|---|---|
| `check <name>: pending` | Informational; wait for a later update. |
| `check <name>: pass`, `skipping`, or `cancel` | Record the terminal result. A canceled required check still needs investigation. |
| `check <name>: fail` | Open the check URL from `get_pr` full output, inspect its logs, fix the cause, commit, and push. |
| `rebase: BEHIND` | Rebase the head branch onto the PR's base branch and push. |
| `rebase: DIRTY` | Rebase, resolve every conflict, and force-push the feature branch with `--force-with-lease`. |
| `review <login>: <state>` | Read `get_pr` full output; handle any substantive review body or unresolved thread. |
| `comments: <n>` or `review-comments: <n>` | Read full output when the count changed; ignore comments authored by the authenticated user. |
| `feedback [<thread>] <file>:<lines> @<author> <title>` | Read the matching unresolved thread and comment body from full output, inspect the named code, then fix or reply. |
| `reaction EYES: <n>` or `comment-reaction EYES: <n>` | A review bot acknowledged the request; wait for its verdict. |
| `reaction THUMBS_UP: <n>` or `comment-reaction THUMBS_UP: <n>` | The corresponding review completed without findings. |
| `PR <n> finished: MERGED` | Call `unwatch_pr`, fetch/prune the local repository when applicable, and report completion. |
| `PR <n> finished: CLOSED` | Call `unwatch_pr` and report that the PR closed without merging. |

## Handle review feedback

For each active thread in `get_pr` full output:

1. Read the entire thread and relevant local diff/code. Decide whether the finding
   is correct; do not blindly accept reviewer claims.
2. Make and verify pertinent code changes. Keep unresolved design disagreements
   open; resolve settled threads after replying.
3. Push the fix. This restarts checks and produces later MCP updates.
4. Reply through `gh` using the comment and thread IDs from full output. Use the
   repository's comments skill when available; otherwise use GitHub's REST reply
   endpoint and GraphQL `resolveReviewThread` mutation directly.

Continue reacting to MCP updates until the pull request is merged or closed. Do not
remove an active watch merely because all current checks passed; later reviews,
rebases, reruns, and merge events are part of the lifecycle.
