# pr-comments plugin

Provides the `/comments` skill: fetches active (unresolved) PR comments from GitHub, formats them for LLM consumption, and walks through reply drafting + thread resolution — auto-resolving threads whose issue is settled and leaving pending discussions open.

Pass `--include-resolved` to also include resolved threads.
