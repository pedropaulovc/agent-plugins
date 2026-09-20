# watch-pr plugin

Provides the `/watch-pr` skill, an OAuth-authenticated connection to the hosted
[`watch-pr` MCP server](https://watch-pr.vza.net/mcp), and a dependency-free Node 22
SSE watcher. The watcher keeps a pull request attached to the root agent session that
authored it.

The root tool inventory must expose `watch_pr`, `open_pr_monitor`, `get_pr`, and
`unwatch_pr`. If any tool is missing, authenticate the server with
`/mcp reauth plugin:watch-pr:watch-pr`. Claude CLI, another MCP client, and polling are
not supported substitutes.

The server owns GitHub webhooks, minute reconciliation, durable snapshots, and event
cursors. After `watch_pr`, the root session calls `open_pr_monitor` and receives a
read-only `monitorUrl` scoped to that OAuth session and PR. The URL expires after 12
hours and carries no GitHub credential. It may appear in process arguments,
transcripts, and logs.

Start the watcher by passing the URL directly:

```text
node watch-pr-monitor.mjs "<monitorUrl>"
```

The watcher prints:

1. `watch-pr: ready` after the first SSE response has been validated. Reconnects do not
   print readiness again.
2. `<details>` when an actionable change arrives. One watcher is scoped to one PR, so
   intermediate output omits a redundant PR/update prefix. Comment, review, and feedback
   headers keep their IDs, feedback keeps its file and line range, and redundant GitHub
   URLs are omitted. Visible Markdown bodies retain their full length and line breaks.
   Each continuation line starts with `│ ` so body text cannot imitate a watcher record;
   hidden HTML comments remain suppressed.
3. `PR <n> finished: MERGED|CLOSED` before a terminal feed exits.

Routine check completions and no-op webhook deliveries stay silent. A CI rerun emits
one start summary, immediate named failures or cancellations, and one terminal rollup
after pending checks settle. Comment deltas carry the changed comment itself, so a root
agent does not have to fetch and search a PR snapshot containing older comments.

The root acts from each intermediate output block without spending a turn on `get_pr`.
`get_pr` remains the final reconciliation step for merge or closure and a fallback when
an event explicitly lacks required context. The watcher never receives GitHub
credentials and cannot edit, rebase, push, reply, or call MCP tools.

Exactly one watcher runs per PR and root session:

- Claude Code uses one persistent `Monitor`.
- Codex and other agent harnesses use one long-lived watcher subagent.
- Oh My Pi uses one `hub(op: "start")` process with `monitorUrl` as the script's only
  argument and `^watch-pr: ready(?:\r?\n|$)` as its newline-safe readiness condition.

All harnesses retain the same watcher through intermediate events. Cancellation stops
that watcher before `unwatch_pr`. An HTTP 401, 403, or 404 after readiness means the
12-hour URL expired or was revoked. Call `open_pr_monitor` once, put the stopped
watcher's reported last event ID in the replacement URL's `cursor` query parameter,
and start one replacement watcher; events during renewal are replayed. Other permanent
failures stop the watch without falling back to polling.

Claude Code and Codex load the remote server from the inline plugin manifest. The
OpenCode adapter registers the same endpoint and `/watch-pr` command. Aggregate
OpenCode installs can set `mcp.watch-pr.enabled` to `false`; the adapter preserves an
existing MCP entry.
