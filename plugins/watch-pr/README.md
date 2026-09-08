# watch-pr plugin

Provides the `/watch-pr` skill and an OAuth-authenticated connection to the hosted
[`watch-pr` MCP server](https://watch-pr.vza.net/mcp).

The server watches GitHub pull requests through webhooks plus minute refreshes,
stores durable per-account subscriptions, and sends resource-update notifications
for checks, mergeability, reviews, comments, reactions, threads, and terminal
merge/close state. The skill maps those updates to concrete CI, rebase, feedback,
and cleanup actions.

Claude Code and Codex load the remote server from the plugin's MCP configuration.
The OpenCode adapter registers the same remote endpoint and `/watch-pr` command.
OAuth uses dynamic client registration and GitHub authorization; no local Python
watcher, vendored formatter, or long-running subprocess is required.
