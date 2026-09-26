# Privacy policy: onepassword

## What the plugin does

This plugin provides a skill and an OpenCode adapter. It contains no credential, background service, or network client of its own. Its instructions ask the coding agent to use the locally installed 1Password CLI (`op`) and, in OpenCode, register the skill and `/op` command.

## Information and destinations

- **Claude input and tool results:** The skill is loaded into the normal Claude session. User prompts, command arguments, and tool results are handled by Anthropic under the user's ordinary Claude service and account settings. If a different coding-agent host or model provider is used, that host's and provider's normal data practices apply.
- **1Password authentication:** By default, the skill assumes `OP_SERVICE_ACCOUNT_TOKEN` is already in the environment. It does not read the token itself or start sign-in preemptively. When an `op` command fails with an authentication error, the fallback runs `op signin -f` in a persistent tmux Bash pane; the user enters any requested password there, and the CLI communicates with 1Password to authenticate.
- **Session token handling:** The sign-in output is evaluated inside that pane without being printed. Later `op` commands run in the same pane and inherit its environment; the session token is not written to a file, passed as a command argument, copied into another shell, or printed into the assistant's tool transcript. The assistant checks only a non-secret success marker. The token remains in the pane's shell environment until it expires or the agent signs out and closes the pane. Other processes running as the same local user may still be able to inspect shell environments on some platforms; 1Password recommends desktop-app integration for stronger protection.
- **Secrets requested with `op`:** The CLI contacts 1Password when the agent actually runs an `op` command and returns the requested data. The skill does not determine which vault items the user requests. Returned secrets may be included in tool output, subsequent commands, or model context depending on the user's task.

The plugin does not independently send information to any third party. The 1Password service is contacted by the separately installed `op` CLI as described above. This policy describes the plugin's shipped instructions and adapter, not unrelated commands or tools a user chooses to run.
