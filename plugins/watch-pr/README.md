# watch-pr plugin

Provides the `/watch-pr` skill and an OAuth-authenticated connection to the hosted
[`watch-pr` MCP server](https://watch-pr.vza.net/mcp).

The server watches GitHub pull requests through webhooks plus minute refreshes,
stores durable per-account watches, and emits resource-update notifications for
checks, mergeability, reviews, comments, reactions, threads, and terminal state.
The skill maps those updates to CI, rebase, feedback, and cleanup actions.

Claude Code and Codex load the remote server from inline plugin manifest
configuration. The OpenCode adapter registers the same endpoint and `/watch-pr`
command. Clients that do not turn standard MCP notifications into agent turns use
their native recurring-task facility to read the durable snapshot once per minute.
For aggregate OpenCode installs, preconfigure `mcp.watch-pr.enabled` as `false` to
disable the hosted connection; the adapter preserves an existing MCP entry.
OAuth uses dynamic client registration and GitHub authorization; no local Python
watcher, vendored formatter, or GitHub polling subprocess is required.
