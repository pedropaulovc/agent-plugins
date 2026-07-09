---
name: op
description: Use when 1Password CLI session needs to be established interactively, such as when op commands fail with authentication errors or at the start of a session requiring secrets
---

# 1Password Sign-In

## Default: service account token (assumed present)

Assume a service account token is preset in `OP_SERVICE_ACCOUNT_TOKEN`. `op` commands will authenticate automatically — do not run any sign-in flow unless an `op` command actually fails with an auth error. Do not pre-check the env var or run `op whoami` as a probe.

Only fall back to the interactive sign-in below **after** an `op` command has failed with an authentication error.

## Fallback: interactive sign-in (only on auth failure)

Establish an `op` CLI session by running `op signin -f` in a separate tmux pane (so the user can type their password), then capturing the session token.

### Steps

1. Run a single bash command that opens a tmux pane for interactive sign-in, evals the output to capture the session token, then writes only the `OP_SESSION_*` env var to a file:
   ```bash
   rm -f /tmp/op-session.env && tmux split-window -h 'eval $(op signin -f); env | grep "^OP_SESSION_" > /tmp/op-session.env; echo "OP_DONE=$?" >> /tmp/op-session.env' && while [ ! -f /tmp/op-session.env ] || ! grep -q 'OP_DONE=' /tmp/op-session.env 2>/dev/null; do sleep 1; done && cat /tmp/op-session.env
   ```
   Set a long timeout (e.g. 120s) since the user needs time to type their password.

2. If the file contains an `OP_SESSION_*` line: extract it and prefix all subsequent `op` commands with `export <that line> &&`. Verify with `export OP_SESSION_...=... && op whoami`.

3. If the file does not contain an `OP_SESSION_*` line: sign-in failed. Report the error to the user.

## Using the session in subsequent commands

The session token env var name includes the user ID (e.g. `OP_SESSION_D4FVRUPQ7VHULE3OOCDDHS64V4`), NOT the account shorthand. After capturing it, prefix every bash command that needs `op` with:

```bash
export $(grep '^OP_SESSION_' /tmp/op-session.env) && op <command>
```

If your workflow uses a specific 1Password Environment, add `run --environment <env-id> --` after `op` (e.g. `op run --environment <env-id> -- <command>`).

## Why tmux

`op signin -f` requires interactive password input. The Bash tool cannot handle interactive prompts, so we split to a tmux pane where the user types directly. The `eval $(op signin -f)` pattern captures the session token into the shell environment, which we then write to a file for use in other shells.
