---
name: watch-pr
description: Watch a GitHub PR's full lifecycle through the hosted watch-pr MCP server, act on CI and rebase changes, and handle incoming review feedback until merge or closure.
argument-hint: "[pr-url-or-ref]"
---

# Watch a PR to green + merged

Use the hosted `watch-pr` MCP server for durable GitHub webhook ingestion and minute
reconciliation. Use the bundled `watch-pr-monitor.mjs` only for its read-only SSE feed.
MCP resource notifications may be useful hints, but they are never the wake-up or
correctness path.

## Preflight the MCP tools

Before resolving or watching a pull request, confirm that the root session's tool
inventory exposes all four required watch-pr MCP tools:

- `watch_pr`
- `open_pr_monitor`
- `get_pr`
- `unwatch_pr`

If any tool is unavailable, tell the user to authenticate the watch-pr MCP server with
`/mcp reauth plugin:watch-pr:watch-pr`, then stop and wait. Do not continue until the
root tool inventory exposes all four tools. Do not invoke Claude CLI, another client,
another MCP transport, or any polling path as a workaround.

## Root-session boundary

The root session that authored the pull request owns every action: calls to `get_pr`,
code edits, rebases, pushes, review replies, and cleanup. The watcher process and any
subagent hosting it are messengers only. They must never inspect or change the checkout,
call GitHub, call MCP tools, or act on a pull request event.

Run exactly one long-lived watcher for this PR in this root session. Keep that same
watcher alive through every intermediate event; never rearm it, start a recurring poll,
or launch a second watcher. The watcher naturally exits after printing a `merged` or
`closed` PR event.

Do not call `watch_pr`, `open_pr_monitor`, or `unwatch_pr` for this PR from a
second client that shares the same MCP credential. The backend watch scope is
shared by that credential, so another client's `unwatch_pr` revokes the root
watcher's capability. Do not report that a watcher is attached until the
harness returns its concrete process, Monitor, or agent identifier and that
same watcher emits the readiness record.

## Start watching

1. Resolve the pull request with `gh pr view`. If no argument was supplied, resolve the
   current branch:

   ```bash
   gh pr view --json number,url -q '"#\(.number) \(.url)"'
   ```

   For an explicit number, URL, or branch, pass it to `gh pr view`. Keep the full URL;
   its `/OWNER/REPOSITORY/pull/NUMBER` path supplies the MCP arguments without depending
   on the current checkout's remotes.

2. From the root session, call `watch_pr` with:
   - `repository`: `OWNER/REPOSITORY`
   - `number`: the pull-request number

3. From the root session, call `open_pr_monitor` with the same arguments. Parse its JSON
   result and retain the opaque `monitorUrl`. It is a read-only bearer capability for
   this OAuth session and PR.

   If `terminalState` is already `merged` or `closed`, do not mint a capability file
   or launch a watcher. Call `get_pr`, perform the matching terminal action below, and
   clean up with `unwatch_pr`.

   Otherwise, resolve `watch-pr-monitor.mjs` from the absolute directory containing this
   `SKILL.md`; do not search the checkout or assume the current working directory. Start
   its one-shot `mint` helper through a process API with a private stdin channel:

   ```text
   node "<absolute skill directory>/watch-pr-monitor.mjs" mint [absolute-directory]
   ```

   Write `monitorUrl` exactly once to the helper's stdin and capture only its single
   stdout path. Omit `absolute-directory` to use the OS temporary directory. On POSIX,
   a supplied existing directory must be absolute and outside the repository; the helper
   atomically creates an owner-only `0600` file. Windows does not expose POSIX owner
   permission bits, so the helper rejects custom directories and uses the per-user OS
   temporary directory. It atomically creates each capability file with a protected DACL
   granting full control only to the invoking user, verifies that DACL, and writes the URL
   before publishing the path; minting fails closed if that setup cannot run. This excludes
   other unprivileged SIDs, but not same-user processes or elevated Administrator, SYSTEM,
   or backup access. The reader canonicalizes the path and rejects paths outside the canonical
   temporary directory and paths inside a repository. Never interpolate the URL into shell text
   or a heredoc, or put it in arguments, environment variables, output, logs, messages,
   repository files, or process names.
   Do not use a PTY for the mint helper because terminal echo can expose stdin. If the
   harness cannot provide a private stdin channel, fail clearly rather than minting the
   file by hand or exposing the capability.

4. Start exactly one watcher through the harness-native flow below. Pass only the
   capability-file path, never the monitor URL:

   ```text
   node "<absolute skill directory>/watch-pr-monitor.mjs" --url-file "<capability-file>"
   ```

5. Classify each concise stdout line before acting:
   - The exact first line `watch-pr: ready` is the readiness record. It means the first
     SSE response was validated and an otherwise idle watcher is healthy. It is not a
     PR event, does not describe a PR state change, and must not trigger `get_pr`.
   - `PR <n> updated: <changes>` is an intermediate PR event. The suffix names only the
     changed fields; when the event has no changed fields it names the GitHub event
     instead, so a direct base-branch push still wakes the root. Call `get_pr` in brief
     mode for the current details and handle the resulting lifecycle lines.
   - `PR <n> finished: MERGED` or `PR <n> finished: CLOSED` is a terminal PR event.
     Call `get_pr` before performing the matching terminal action below.

   The readiness record is emitted exactly once, including across SSE reconnects, and
   precedes any PR event. Use `list_pr_events` only to explain a transition. Use
   `get_pr` with `mode: "full"` when bodies, thread IDs, URLs, or exact snapshot fields
   are needed. The watcher deliberately omits those details to keep wake output concise.

## Start the harness watcher

### Claude Code

Create one persistent `Monitor` running the watcher command with only the
capability-file path. Keep that Monitor active after intermediate updates. Treat
`watch-pr: ready` only as successful startup; each later `PR <n> updated: ...` or
`PR <n> finished: ...` line must wake the root session, which calls `get_pr`. Do not
run the command in an ordinary background shell, create a scheduled task, or replace
the Monitor after an intermediate event. Record the Monitor identifier for explicit
cancellation.

### Codex

Call `spawn_agent` once to create one long-lived watcher subagent. Give it only the
capability-file path inside this private task, never the monitor URL, and instruct it
exactly as follows:

```text
Run `node "<absolute skill directory>/watch-pr-monitor.mjs" --url-file
"<capability-file>"` in the foreground. The exact line `watch-pr: ready` is startup
readiness, not a PR event: report readiness to the root without calling or requesting
get_pr, then continue reading the same process. For each `PR <n> updated: ...` line,
immediately send the exact line to the root session through the parent-message channel,
then continue reading the same process. For `PR <n> finished: MERGED` or
`PR <n> finished: CLOSED`, return the exact line to the root as the terminal result and
exit. If the process writes stderr or exits nonzero, send the error to the root and
exit. Do not call MCP or GitHub tools, inspect or modify files, rebase, push, reply,
poll, restart, or launch another watcher.
```

Retain the agent identifier. Do not close it or treat readiness or an intermediate
message as its result. The root reacts only to PR-event messages and leaves the same
subagent running until the terminal result or explicit cancellation.

### Oh My Pi

The `mint` helper from step 3 is a short-lived setup process, not the watcher. Oh My Pi's
`hub(op: "start")` has no stdin at launch, so start the helper with `pty: false` and
`progress: "off"`, send `monitorUrl` through its private stdin with `hub(op: "send")`,
read its path-only stdout, and wait for it to exit before starting the watcher below.
Never put the URL in `args`, `env`, shell text, or a PTY that can echo input.

```text
hub(
  op: "start",
  name: "watch-pr-mint-<owner>-<repository>-<number>",
  application: "node",
  args: ["<absolute skill directory>/watch-pr-monitor.mjs", "mint"],
  pty: false,
  progress: "off"
)
hub(op: "send", name: "watch-pr-mint-<owner>-<repository>-<number>", text: "<monitorUrl>", enter: true)
```

The mint helper must finish successfully and return one capability-file path. Stop or
clean up that short-lived helper before starting the one persistent watcher.
Start one hub-managed persistent process with `hub(op: "start")`. Use a capability-free,
unique name and pass only the capability-file path as the watcher argument:

```text
hub(
  op: "start",
  name: "watch-pr-<owner>-<repository>-<number>",
  application: "node",
  args: ["<absolute skill directory>/watch-pr-monitor.mjs", "--url-file", "<capability-file>"],
  ready: {
    log: "^watch-pr: ready$",
    timeout: 60
  },
  progress: "wake"
)
```

Retain the process name for cancellation. The matching line establishes readiness and
must not trigger `get_pr`. Keep the same process running; every later
`PR <n> updated: ...` or `PR <n> finished: ...` line wakes the root session, which calls
`get_pr`. Do not use asynchronous Bash, `hub wait`, job polling, a second process, or a
restart after intermediate events.

### Other or uncertain harnesses

Spawn exactly one long-lived subagent with the same capability-file,
foreground-command, and messaging contract shown for Codex. It must distinguish the
one `watch-pr: ready` line from later `PR <n> ...` events: readiness reports successful
startup without triggering `get_pr`; intermediate updates are sent to the root while
the same process continues; only a terminal `PR <n> finished: ...` line or error ends
the subagent. If the harness cannot keep a subagent alive and
deliver its messages to the root, report that the required watch cannot be established
rather than substituting polling, a detached shell, MCP notifications, or repeated
watcher launches.

## Act on lifecycle lines

| Line | Action |
|---|---|
| `PR <n>: <state> [DRAFT]` | Record the current lifecycle state and whether review is still blocked by draft status. |
| `head: <ref>@<sha>` | If the SHA changed, inspect the new commit and restarted checks before acting on earlier results. |
| `mergeable: <yes\|no> (<state>)` | Treat `BEHIND` and `DIRTY` through the rebase actions below; other states are informational. |
| `reviews: <n>` | Read full output when the count changed; `0` explicitly means no reviews. |
| `check <name>: pending` | Informational; wait for a later update. |
| `check <name>: pass`, `skipping`, or `cancel` | Record the terminal result. A canceled required check still needs investigation. |
| `check <name>: fail` | Open the check URL from `get_pr` full output, inspect its logs, fix the cause, commit, and push. |
| `rebase: BEHIND` | Rebase the head branch onto the PR's base branch and push. |
| `rebase: DIRTY` | Rebase, resolve every conflict, and force-push the feature branch with `--force-with-lease`. |
| `review <login>: <state>` | Read `get_pr` full output; handle any substantive review body or unresolved thread. |
| `comments: <n>` or `review-comments: <n>` | Read full output when the count changed; ignore comments authored by the authenticated user. |
| `feedback [<thread>] <file>:<lines> @<author> <title>` | Read the matching unresolved thread and comment body from full output, inspect the named code, then fix or reply. |
| `reaction <kind>: <n>` or `comment-reaction <kind>: <n>` | Informational aggregate only. Read full comments/reviews before attributing a reaction to a reviewer or treating it as a verdict. |
| `PR <n> finished: MERGED` | Call `get_pr`, call `unwatch_pr`, fetch/prune the local repository when applicable, and report completion. The watcher exits on its own. |
| `PR <n> finished: CLOSED` | Call `get_pr`, call `unwatch_pr`, and report that the PR closed without merging. The watcher exits on its own. |

## Handle review feedback

For each active thread in `get_pr` full output:

1. Read the entire thread and relevant local diff/code. Decide whether the finding is
   correct; do not blindly accept reviewer claims.
2. Make and verify pertinent code changes. Keep unresolved design disagreements open;
   resolve settled threads after replying.
3. Push the fix. This restarts checks and produces later feed events.
4. Reply through `gh` using the comment and thread IDs from full output. Use the
   repository's comments skill when available; otherwise use GitHub's REST reply
   endpoint and GraphQL `resolveReviewThread` mutation directly.

Continue until the watcher reports merge or closure. Passing checks is intermediate;
later reviews, rebases, reruns, and merge events remain part of the same lifecycle.

## Cancel or handle watcher failure

If the user cancels before a terminal event, first stop the exact harness watcher:
stop the Claude Monitor, interrupt and close the Codex/generic subagent, or call
`hub(op: "stop", name: "<recorded process name>")` for Oh My Pi. Confirm that process
has ended, delete the capability file if the watcher failed before consuming it, then
call `unwatch_pr`. Never leave a detached process or capability file behind.

A permanent watcher error is not an invitation to rearm. Report its stderr to the root,
stop/close its harness container, delete the capability file if startup failed before
the watcher consumed it, call `unwatch_pr` when possible, and do not launch a
replacement watcher in this session. Apply the same file cleanup if startup is
cancelled while the watcher is still opening the file.
