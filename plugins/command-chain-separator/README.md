# command-chain-separator plugin

A Rust PreToolUse hook for **Bash** that injects two blank lines between commands chained with `&&` or `;`, so per-command output is easy to read in long chains.

**Rewrite:**

```
# input
npm install && npm run build && npm test

# output (what actually executes)
npm install && printf '\n\n' && npm run build && printf '\n\n' && npm test
```

Same idea for `;`-separated commands. `printf` (not `echo`) is used so the `\n` escapes render as real newlines on every shell; single-quoting keeps the backslashes literal until printf consumes them.

**Behavior:**
- Only matches the `Bash` tool
- Splices ` printf '\n\n' <op>` *after* each top-level `&&` or `;`, preserving the original operator so chain semantics don't change (`&&` still short-circuits)
- Quote-aware: separators inside `'...'`, `"..."`, `` `...` ``, `$'...'`, `$(...)`, `${...}`, and `(...)` subshells are ignored
- Bails out silently (no rewrite) on commands containing constructs where splicing would break semantics:
  - Heredocs (`<<EOF`, `<<-EOF`)
  - Brace command groups (`{ cmd; cmd; }`)
  - `;;` case-statement terminators
  - Word-boundary `#` comments
  - Opening control-flow keywords at command position: `if`, `for`, `while`, `case`, `function`, `select`, `until`
- Bypass: add `[no-rewrite]` to the tool description

**Known limitations (intentional, prioritizing safety):**
- Any command containing an opening control-flow keyword bails the *entire* command, even safe outer `&&` chains around it (e.g. `echo a && for x in 1 2; do …; done && echo b` is not rewritten)
- Backquoted/subshelled control flow also triggers a bail of the outer chain
- Newlines are not spliced (they're statement separators in bash, but injection targets only `&&` and `;`)

## Build

```
python3 hooks/build-hooks.py
```

Cross-compiles the Rust binary for Linux x86_64 and Windows x86_64 and copies the outputs to `hooks/bin/`. Run after any change to the Rust source or when bumping the plugin version.

## Codex support

Claude Code: rewrites unconditionally. **Codex:** rewriting a Bash command requires `permissionDecision: "allow"`, which also skips Codex's approval prompt — so to avoid slipping a chained command past that prompt, the hook only rewrites in `bypassPermissions`/`dontAsk` modes and stays inert (no separators) in approval-requiring modes.
