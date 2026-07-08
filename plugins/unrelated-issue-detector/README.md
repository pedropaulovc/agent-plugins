# unrelated-issue-detector plugin

A Rust Stop hook that detects when Claude dismisses unrelated issues found during development and prompts investigation.

## Build

```
python3 hooks/build-hooks.py
```

## Codex support

Works in both. The `Stop` hook parses both Claude Code transcripts and Codex rollout logs.
