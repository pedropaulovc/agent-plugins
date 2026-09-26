# Privacy policy: mediocrity-detector

The detector runs locally as a Stop hook. Claude Code supplies a transcript path; the hook reads that transcript file and scans assistant-authored text and supported file-edit content from the current turn for configured shortcut phrases and code markers. It does not scan arbitrary project files. A match and its surrounding phrase are returned to the host as a reason to continue rather than stop.

In OpenCode, the plugin requests the active session's messages through OpenCode's provided client, writes them to a temporary JSONL file on the local machine for the same scanner, and removes the temporary directory after the scan. If a match is found, it may submit one synthetic corrective prompt to that same session. These reads and prompts use the configured OpenCode server, which may be remote. On Claude Code and OpenCode, transcript/session data remains subject to the host platform's normal storage and model-provider policies.

The plugin has no standalone network client, telemetry sender, or persistent transcript store. It does not send a second copy of the transcript to a separate service. OpenCode session retrieval and prompt submission use the host-provided client and are handled by the configured server. The local binary only returns a decision and any matching phrase context to the host process.
