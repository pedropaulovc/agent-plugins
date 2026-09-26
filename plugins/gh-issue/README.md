![gh-issue icon](icon.svg)

# gh-issue plugin

[Documentation](https://go.vza.net/agent-plugins/gh-issue/docs) · [Support](https://go.vza.net/agent-plugins/gh-issue/support) · [Privacy](https://go.vza.net/agent-plugins/gh-issue/privacy) · [Local privacy details](PRIVACY.md)

Provides the `/issue` skill: transforms terse bug reports or feature requests into well-structured, actionable GitHub issues via `gh issue create`.

## Operations and data

When invoked, `/issue` uses the conversation, clarifying answers, and any relevant
workspace context the agent is permitted to read to draft a GitHub issue. It then runs
`gh issue create`, which submits the issue title, body, and any selected labels to GitHub
for the repository and account configured in the local `gh` CLI.

The plugin has no separate background service or telemetry sender and does not fetch web
content itself. The host model processes the conversation under its own service policy.

## Codex and OpenCode support

Works in both. Explicit-only — invoke with `/issue` (Claude Code) or `$issue` (Codex); it is never auto-selected (`agents/openai.yaml` sets `allow_implicit_invocation: false` for Codex).

OpenCode exposes `/issue`. OpenCode does not support explicit-only skill discovery, so the instruction remains visible to its model as well.
