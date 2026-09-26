---
name: op
description: Use when 1Password CLI session needs to be established interactively, such as when op commands fail with authentication errors or at the start of a session requiring secrets
---

# 1Password Sign-In

## Default: service account token (assumed present)

Assume a service account token is preset in `OP_SERVICE_ACCOUNT_TOKEN`. `op` commands will authenticate automatically — do not run any sign-in flow unless an `op` command actually fails with an auth error. Do not pre-check the env var or run `op whoami` as a probe.

Only fall back to the interactive sign-in below **after** an `op` command has failed with an authentication error.

## Fallback: interactive sign-in (only on auth failure)

Sign in within a persistent tmux pane. The pane's shell retains the session environment for later `op` commands; never transfer an `OP_SESSION*` value to another shell, file, command argument, or tool response. The 1Password CLI documents `eval "$(op signin)"` for manual sign-in; `-f` suppresses warnings. Do **not** use `--raw`, print the sign-in output, enable shell tracing, or capture the pane while signing in. App-integrated sign-in also works with `op signin`.

1. Open a Bash pane and note the pane ID printed by tmux (not a credential):

   ```bash
   tmux split-window -h -P -F '#{pane_id}' 'bash --noprofile --norc'
   ```

2. Substitute that pane ID for `%N` below. Send the sign-in command to the pane; the user enters any requested password there. Command substitution captures the CLI's shell assignment **inside the pane**, rather than displaying it. Check the exit status before evaluating it and discard the captured string afterward:

   ```bash
   tmux send-keys -t '%N' -l 'set +x; signin_output=$(op signin -f); signin_status=$?; if [ "$signin_status" -eq 0 ] && eval "$signin_output"; then unset signin_output; printf "\nOP_SIGNIN_OK\n"; else unset signin_output; printf "\nOP_SIGNIN_FAILED\n"; fi'
   tmux send-keys -t '%N' Enter
   ```

   Allow time for the user's interactive sign-in. Check only for the success marker without printing the pane's contents to the tool transcript:

   ```bash
   tmux capture-pane -pt '%N' | grep -q '^OP_SIGNIN_OK$'
   ```

   If the marker does not appear after sign-in completes, ask the user to inspect the error in the pane (do not paste credentials or capture the pane's sign-in output). Retry sign-in in the same pane if needed.

3. Send subsequent commands to **that same pane** so the exported session variable remains in its shell. For example:

   ```bash
   tmux send-keys -t '%N' -l 'op whoami'
   tmux send-keys -t '%N' Enter
   ```

   Wait for the command to finish before reading its result. Capture only the output needed for the user's task, and remember that `op` results themselves can contain secrets. Never run `env`, `printenv`, `set`, or `export -p` in that pane or capture its sign-in output. Do not run a fresh `op` process in another shell expecting it to inherit this session.

If your workflow uses a specific 1Password Environment, run `op run --environment <env-id> -- <command>` in the same pane. When finished, run `op signout` there and close the pane with `tmux kill-pane -t '%N'`. An expired session requires signing in again in the pane.

## Why tmux

Manual sign-in needs interactive password input. The tmux pane accepts it directly from the user and keeps the resulting `OP_SESSION*` environment variable within its shell; subsequent `op` commands inherit it without revealing or storing the token outside the pane.
