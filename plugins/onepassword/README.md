# onepassword plugin

Provides the `op` skill: establishes a 1Password CLI (`op`) session when authentication fails.

The default assumption is a service account token in `OP_SERVICE_ACCOUNT_TOKEN`, so `op` just works and no sign-in flow runs. Only when an `op` command actually returns an auth error does the skill fall back to an interactive `op signin -f` in a separate tmux pane — where the user types their password directly — then captures the `OP_SESSION_*` token into a file for reuse across subsequent shells.

## Codex and OpenCode support

Works in both. Model-invocable — it auto-fires on an `op` auth failure (or invoke explicitly with `/op` in Claude Code, `$op` in Codex).

OpenCode registers the skill and exposes `/op`.
