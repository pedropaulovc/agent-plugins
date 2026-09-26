# Privacy — command-chain-separator

## What this plugin does

The plugin's local PreToolUse hook receives a JSON event from the agent host. For matching Bash events, it reads the command and tool description, optionally rewrites top-level `&&` and `;` separators, and returns updated tool input and advisory context. It does not execute the command; the host decides whether and how to run it. Under Codex, rewriting occurs only in `bypassPermissions` or `dontAsk` modes, where approval is already skipped.

## Information processed

The host passes the Bash command and related tool input to the hook on standard input. The local hook processes that input in memory and writes its result to standard output; it does not save command content to a file or make network requests. In Claude Code, the prompt and tool inputs/results are also part of the normal Claude conversation processed under the account's applicable privacy and data controls; this is separate from the hook's local processing. The host may apply its own retention settings.

The Bash command that the host later executes can itself access files, credentials, or network services. Such activity is controlled by that command and the host's permissions, not by this separator hook. Do not treat the hook's local processing as a privacy or security boundary.