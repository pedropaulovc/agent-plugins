# Privacy

This policy describes the bundled detector. It does not replace the privacy terms of the coding-agent host.

## Inputs and local processing

Claude Code and Codex invoke the native Stop hook with a local transcript path and session identifier. The hook reads only newly appended transcript bytes, extracts assistant text, and scans that text for a fixed list of dismissal phrases. On a match, it returns a short surrounding excerpt and an evidence-request message to the same agent session. The hook does not decide whether the dismissal is true, inspect project files, or contact an issue tracker.

The hook stores a numeric byte offset in a file named for the session under the operating system's temporary directory; it does not store the scanned transcript in that file. In OpenCode, the adapter stages the current session messages in a temporary JSONL file, runs the local detector, removes the staging directory and offset file, and submits any corrective prompt to that OpenCode session through its host API. The host controls the transport for that API.

The runtime has no outbound HTTP client or configured third-party endpoint. Any prompts, project context, or corrective response sent by Claude Code to Anthropic are handled under the host's service and privacy terms; the detector does not separately forward them to its publisher.

## Links

- [Documentation](https://go.vza.net/agent-plugins/unrelated-issue-detector/docs)
- [Support](https://go.vza.net/agent-plugins/unrelated-issue-detector/support)
- [Privacy page](https://go.vza.net/agent-plugins/unrelated-issue-detector/privacy)
