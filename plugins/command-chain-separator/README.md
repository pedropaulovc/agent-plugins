# command-chain-separator plugin

A Rust PreToolUse hook for **Bash** that injects a visible `=========` line between commands chained with `&&` or `;`, so per-command output is easy to read in long chains.

**Rewrite:**

```
# input
npm install && npm run build && npm test

# output (what actually executes)
npm install && echo "\n\n ========= \n\n" && npm run build && echo "\n\n ========= \n\n" && npm test
```

Same idea for `;`-separated commands.

**Behavior:**
- Only matches the `Bash` tool
- Splices ` echo "\n\n ========= \n\n" <op>` *after* each top-level `&&` or `;`, preserving the original operator so chain semantics don't change (`&&` still short-circuits)
- Quote-aware: separators inside `'...'`, `"..."`, `` `...` ``, `$'...'`, `$(...)`, `${...}`, and `(...)` subshells are ignored
- Bails out silently (no rewrite) on commands containing constructs where splicing would break semantics:
  - Heredocs (`<<EOF`, `<<-EOF`)
  - Brace command groups (`{ cmd; cmd; }`)
  - `;;` case-statement terminators
  - Word-boundary `#` comments
  - Opening control-flow keywords at command position: `if`, `for`, `while`, `case`, `function`, `select`, `until`
- Bypass: add `[no-rewrite]` to the tool description

**About the literal `\n` in the injected echo:** the default `echo` builtin doesn't interpret escape sequences, so the output is a literal `\n\n ========= \n\n` line — the `=========` marker still works as a visible boundary. If you want actual blank lines, change `echo` to `printf` or `echo -e` in `src/main.rs` and rebuild.

**Known limitations (intentional, prioritizing safety):**
- Any command containing an opening control-flow keyword bails the *entire* command, even safe outer `&&` chains around it (e.g. `echo a && for x in 1 2; do …; done && echo b` is not rewritten)
- Backquoted/subshelled control flow also triggers a bail of the outer chain
- Newlines are not spliced (they're statement separators in bash, but inject the resize tip only `&&` and `;`)

## Build

```
python3 hooks/build-hooks.py
```

Cross-compiles the Rust binary for Linux x86_64 and Windows x86_64 and copies the outputs to `hooks/bin/`. Run after any change to the Rust source or when bumping the plugin version.
