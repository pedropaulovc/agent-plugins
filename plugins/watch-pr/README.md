# watch-pr plugin

Provides the `/watch-pr` skill, an OAuth-authenticated connection to the hosted
[`watch-pr` MCP server](https://watch-pr.vza.net/mcp), and a dependency-free Node 22
SSE watcher that keeps the pull request attached to the root agent session that authored
it.

The server owns GitHub webhooks, minute reconciliation, durable snapshots, and durable
event cursors. After `watch_pr`, the root session calls `open_pr_monitor` and passes its
opaque read-only `monitorUrl` to
`skills/watch-pr/watch-pr-monitor.mjs`. The watcher prints one compact JSON line per
feed event, reconnects from its last event ID without duplicate output, stays alive
through intermediate activity, and exits successfully on merge or closure. It never
receives GitHub credentials and never edits, rebases, pushes, or replies.

Exactly one watcher is allowed per PR/root session. The same watcher remains active for
checks, reviews, feedback, rebases, and reruns; it is not rearmed after each event. The
root session calls `get_pr` after every watcher line and owns all action. Standard MCP
resource notifications are optional hints and are not the correctness path.

Harness integration is intentionally native:

- **Claude Code:** one persistent `Monitor` runs the Node watcher and wakes the root on
  each line.
- **Codex:** one long-lived `spawn_agent` subagent runs it in the foreground, messages
  each intermediate line to the root without exiting, and returns only at merge,
  closure, or error.
- **Oh My Pi:** one Bash async job uses `async: true` with `progress: "wake"`; its job ID
  is retained for cancellation.
- **Other harnesses:** one long-lived subagent follows the same foreground-process and
  root-message contract. A harness that cannot deliver intermediate messages must fail
  clearly rather than fall back to polling or detached processes.

Canceling a nonterminal watch always stops the harness watcher first and then calls
`unwatch_pr`. A terminal event makes the watcher exit naturally; the root calls
`get_pr`, performs terminal cleanup, and calls `unwatch_pr`.

Claude Code and Codex load the remote server from inline plugin manifest configuration.
The OpenCode adapter registers the same endpoint and `/watch-pr` command. For aggregate
OpenCode installs, preconfigure `mcp.watch-pr.enabled` as `false` to disable the hosted
connection; the adapter preserves an existing MCP entry. OAuth uses dynamic client
registration and GitHub authorization, while service detection remains read-only.
