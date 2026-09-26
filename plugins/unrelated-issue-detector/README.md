# unrelated-issue-detector plugin
![Unrelated issue detector icon](icon.svg)

A Rust hook that scans new assistant transcript text for fixed phrases describing issues as pre-existing, unrelated, out of scope, or separate. A match blocks the agent from stopping and asks it to report the symptom and evidence; the hook does not decide whether the claim is true.

## Build

The bundled executables target x86_64 Linux and Windows. Building from source requires Rust/Cargo and the cross-compilation targets and tools used by `hooks/build-hooks.py`; that script reports and skips an individual target if its build fails.

```bash
python3 hooks/build-hooks.py
```

## Runtime and data handling

Claude Code and Codex run the Stop hook on Linux and Windows. It reads the host-provided local transcript from the last saved byte offset, scans assistant text only, and stores a numeric offset in the operating system's temporary directory. On a phrase match it returns a short surrounding excerpt and evidence request to the same agent session. It does not inspect project files or call an issue-tracking service.

OpenCode checks the current turn when the session becomes idle, stages session text in a temporary file, and submits a corrective prompt to that same session if a phrase matches. The temporary staging files are removed afterward. The runtime has no configured external network endpoint; prompts and project context continue to be handled by the coding-agent host under its own terms.

Because matching is literal, a hit is a request for evidence—not a finding that the dismissal is wrong. An accurate statement that an issue is unrelated or pre-existing can still trigger. The hook is inactive on platforms other than Linux and Windows.

## Plugin resources

[Documentation](https://go.vza.net/agent-plugins/unrelated-issue-detector/docs) · [Support](https://go.vza.net/agent-plugins/unrelated-issue-detector/support) · [Privacy](https://go.vza.net/agent-plugins/unrelated-issue-detector/privacy) · [Local privacy notice](PRIVACY.md)
