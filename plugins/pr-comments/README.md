# pr-comments plugin

Provides the `/comments` skill: fetches active (unresolved) PR comments from GitHub, formats them for LLM consumption, and walks through reply drafting + thread resolution — auto-resolving threads whose issue is settled and leaving pending discussions open.

Pass `--include-resolved` to also include resolved threads.

## Codex and OpenCode support

Works in both. The reply signature is harness-aware (`Claude Code` vs `Codex`). Under Codex there is no `$ARGUMENTS` substitution, so pass the PR ref from your prompt; the skill is explicit-only.

OpenCode exposes `/comments`; its adapter places command arguments in the prompt before loading the skill.
