# onepassword plugin

![onepassword plugin icon](icon.svg)

The `op` skill guides the coding agent through 1Password CLI (`op`) authentication recovery. It assumes `OP_SERVICE_ACCOUNT_TOKEN` is already available to `op` and does not start a sign-in flow before an `op` command actually fails with an authentication error.

## What it does

After an authentication failure, the skill instructs the agent to open a persistent tmux Bash pane and run `op signin -f` there, where the user types any requested password directly. The pane's shell evaluates the CLI's sign-in output without printing it and retains the session environment for subsequent `op` commands in that same pane. No session token is copied to a file, another shell, or the assistant's tool transcript. The assistant checks a non-secret success marker, not the sign-in output; `op` command results may still contain secrets and should be handled accordingly. When finished, sign out and close the pane.

The plugin contains instructions and a small OpenCode adapter that registers the skill and `/op` command; it does not itself run `op`, contact 1Password, or fetch secrets on activation. When the agent runs `op`, the installed CLI uses the supplied service-account or session token to contact 1Password and returns the requested result. Secrets returned by `op` may be visible to the assistant and may flow onward if used in a later command or prompt. The plugin includes no 1Password credentials.

## Privacy and support

Claude prompts and tool results, including output the user asks Claude to obtain with `op`, are handled by Anthropic as part of the ordinary Claude session. The 1Password CLI separately contacts 1Password when invoked. See the [privacy policy](PRIVACY.md) for these data flows.

- [Documentation](https://go.vza.net/agent-plugins/onepassword/docs)
- [Support](https://go.vza.net/agent-plugins/onepassword/support)
- [Privacy policy](https://go.vza.net/agent-plugins/onepassword/privacy)
