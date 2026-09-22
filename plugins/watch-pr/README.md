# watch-pr plugin

Provides the `/watch-pr` skill, an OAuth-authenticated connection to the hosted
[`watch-pr` MCP server](https://watch-pr.vza.net/mcp), and a dependency-free Node 22
SSE watcher. The watcher keeps a pull request attached to the root agent session that
authored it.

The root tool inventory must expose `watch_pr`, `get_pr`, and
`unwatch_pr`. If any tool is missing, authenticate the server with
`/mcp reauth plugin:watch-pr:watch-pr`. Claude CLI, another MCP client, and polling are
not supported substitutes.

The server owns GitHub webhooks, minute reconciliation, durable snapshots, and event
cursors. The single `watch_pr` call subscribes and returns a read-only
`monitor.monitorUrl` scoped to that OAuth session and PR. The URL expires after 12
hours and carries no GitHub credential. It may appear in process arguments,
transcripts, and logs.

Start the watcher by passing the URL directly:

```text
node watch-pr-monitor.mjs "<monitorUrl>"
```

The watcher prints only:

1. `<details>` when an actionable change arrives. One watcher is scoped to one PR, so
   intermediate output omits a redundant PR/update prefix. Comment, review, and feedback
   headers keep their IDs, feedback keeps its file and line range, and redundant GitHub
   URLs are omitted. Visible Markdown bodies retain their full length and line breaks.
   Each continuation line starts with `│ ` so body text cannot imitate a watcher record;
   hidden HTML comments remain suppressed.
2. `PR <n> finished: MERGED|CLOSED` before a terminal feed exits.

Startup and idle feeds are silent. Permanent connection failures go to stderr and
terminate the process. Sustained transient failures emit one stderr warning per outage
while retries continue, so silence alone does not prove that the feed is connected.

Routine check completions and no-op webhook deliveries stay silent. A CI rerun emits one
`checks: <name> -> <status>` record per affected check, each on its own physical line:
start records, immediate named failures or cancellations, and terminal records
after pending checks settle. Comment deltas carry the changed comment itself, so a root
agent does not have to fetch and search a PR snapshot containing older comments.

The root acts from each intermediate output block without spending a turn on `get_pr`.
`get_pr` remains the final reconciliation step for merge or closure and a fallback when
an event explicitly lacks required context. The watcher never receives GitHub
credentials and cannot edit, rebase, push, reply, or call MCP tools.

Run at most one active watcher per PR and root session:

- Claude Code uses one persistent `Monitor`.
- Codex and other agent harnesses use one long-lived watcher subagent.
- Oh My Pi uses one `hub(op: "start")` process with `monitorUrl` as the script's only
  argument. No readiness pattern is required because an idle watcher emits nothing.

Prefer retaining the same watcher through intermediate events. If it exits or can no
longer continue, the root agent may rearm after confirming the old process is stopped.
Local launch errors can reuse a still-valid URL. HTTP 401, 403, or 404 failures include
the last event ID. Call `watch_pr` again, replace the returned `monitor.monitorUrl`'s
`cursor` query parameter with that ID, and start the replacement with the URL as its
only argument.
Remove `cursor` when the ID is empty, then reconcile the gap once with `get_pr`. Never
run duplicate watchers or substitute recurring polling.

Claude Code and Codex load the remote server from the inline plugin manifest. The
OpenCode adapter registers the same endpoint and `/watch-pr` command. Aggregate
OpenCode installs can set `mcp.watch-pr.enabled` to `false`; the adapter preserves an
existing MCP entry.
