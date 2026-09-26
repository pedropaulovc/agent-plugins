# Privacy

This notice describes the worktree-reset skill and its local reset script. It does not replace the policies of Claude Code, GitHub, or package and source hosts used by a project.

## Agent input and local operations

The skill uses harness tools to stop and verify its own background work before resetting. For each `watch-pr` monitor started by the current session, it asks the hosted `watch-pr` MCP service at `https://watch-pr.vza.net/mcp` to remove the watch after the monitor has stopped. This cleanup sends the pull-request identifier through the existing authenticated connection. Watches are scoped by MCP credential and pull request, not by client session: if another session watches the same PR with the same credential, `unwatch_pr` cancels its watch too.

The local Python script inspects Git status, worktree metadata, branch and stash lists, and files needed for dependency setup. It runs Git commands to fetch/prune the configured remote, reset or rebase worktrees against `origin/main`, remove stale branches, and synchronize submodules when requested by its mode. With `--force`, it can discard tracked, untracked, ignored, and stashed changes, remove linked worktrees, and reset the primary `main` branch. Normal mode preserves tracked changes and requires explicit review and confirmation before deleting the listed untracked paths.

When matching project files exist, it invokes `npm install`, `go mod download`, or `uv sync --locked`. Git remotes, submodule sources, package registries, and any additional destinations are determined by the checkout and the installed tools' configuration, not by a fixed vendor URL in this plugin. These commands may download project or dependency data and run with the local permissions of the reset process.

## External services

The reset implementation does not include its own telemetry client. Git, submodule, and package-manager commands can contact the project's configured remotes or registries. Claude Code sends prompts and project context to Anthropic according to its settings; actions initiated by the agent or local commands are subject to those tools' and services' own policies.

## Links

- [Documentation](https://go.vza.net/agent-plugins/worktree-reset/docs)
- [Support](https://go.vza.net/agent-plugins/worktree-reset/support)
- [Privacy page](https://go.vza.net/agent-plugins/worktree-reset/privacy)
