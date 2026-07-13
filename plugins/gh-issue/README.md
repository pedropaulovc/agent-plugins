# gh-issue plugin

Provides the `/issue` skill: transforms terse bug reports or feature requests into well-structured, actionable GitHub issues via `gh issue create`.

## Codex and OpenCode support

Works in both. Explicit-only — invoke with `/issue` (Claude Code) or `$issue` (Codex); it is never auto-selected (`agents/openai.yaml` sets `allow_implicit_invocation: false` for Codex).

OpenCode exposes `/issue`. OpenCode does not support explicit-only skill discovery, so the instruction remains visible to its model as well.
