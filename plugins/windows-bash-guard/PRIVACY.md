# Privacy

This notice describes the bundled Windows Bash guard. It does not replace the privacy terms of the coding-agent host.

## Runtime input and output

Claude Code and Codex pass the Bash hook a local JSON event that includes the command and relevant tool fields; OpenCode passes its Bash arguments to the local helper. On Windows, the Rust helper checks the command for its supported path patterns. When a rewrite applies, it returns the changed command and an explanation to the same harness. Codex only rewrites when the session is already in a permission mode that skips approval. The helper does not read transcripts, write persistent data, or make network requests.

The host controls how the original command, rewritten command, and returned context are handled after the hook returns. Any prompts or project context sent by Claude Code to Anthropic are governed by Claude Code's service settings and policies; this plugin does not separately forward them to its publisher.

## Optional local analysis and builds

Separate, manually invoked transcript-analysis utilities can read JSONL files from directories you choose and write local records containing commands, up to 2,000 characters of error output, categories, relative transcript filenames, timestamps, and working directories. They are not part of normal hook startup and the inspected utilities do not upload those records. Building the native binaries or installing the nested helper package can resolve dependencies through your configured Cargo or npm registries; that is a development/setup action, not a runtime fetch by the hook.

## Links

- [Documentation](https://go.vza.net/agent-plugins/windows-bash-guard/docs)
- [Support](https://go.vza.net/agent-plugins/windows-bash-guard/support)
- [Privacy page](https://go.vza.net/agent-plugins/windows-bash-guard/privacy)
