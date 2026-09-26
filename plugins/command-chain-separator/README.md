# command-chain-separator plugin

![Command Chain Separator plugin icon](./icon.svg)

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
- Splices ` printf '\n\n' <op>` after each top-level `&&` or `;`, preserving that operator so `&&` still short-circuits. The inserted `printf` is an extra command; after a `;`, a following `$?` may observe `printf`'s status instead of the preceding command's
- Quote-aware: separators inside `'...'`, `"..."`, `` `...` ``, `$'...'`, `$(...)`, `${...}`, and `(...)` subshells are ignored
- Bails out silently (no rewrite) on commands containing constructs where splicing would break semantics:
  - Any unquoted `<<` sequence aborts rewriting, including heredocs (`<<EOF`, `<<-EOF`) and here-strings (`<<<`)
  - Any unquoted `{` outside `${...}` aborts rewriting, including brace command groups and brace expansions
  - `;;` case-statement terminators
  - Word-boundary `#` comments
  - Opening control-flow keywords at command position: `if`, `for`, `while`, `case`, `function`, `select`, `until`
- Bypass: add `[no-rewrite]` to the tool description

**Known limitations (intentional, prioritizing safety):**
- Any command containing an opening control-flow keyword bails the *entire* command, even safe outer `&&` chains around it (e.g. `echo a && for x in 1 2; do …; done && echo b` is not rewritten)
- Control-flow keywords found while scanning subshells and command substitutions can bail out the outer chain; backquoted content is skipped as an opaque quoted region and its internal control flow does not trigger that bailout
- Newlines are not spliced (they're statement separators in bash, but injection targets only `&&` and `;`)

## Build

```
python3 hooks/build-hooks.py
```

Attempts to build the Rust binary for Linux x86_64 and Windows x86_64 and copies each successful output to `hooks/bin/`; a failed target is warned about and skipped. Use after Rust source changes or when the bundled platform binaries need refreshing.

## Codex and OpenCode support

Claude Code has no permission-mode gate, but rewrites only eligible Bash commands on supported Linux/Windows builds. The hook's Codex path rewrites only when the session is already in `bypassPermissions` or `dontAsk`; it stays inert when approval is required. The Codex hook launcher resolves its binary through `CLAUDE_PLUGIN_ROOT`, while the Rust hook detects Codex through `PLUGIN_ROOT`, so the host must provide the launcher path as well.

**OpenCode:** on Linux/Windows, mutates eligible Bash arguments in `tool.execute.before` without changing the normal permission flow; when a rewrite occurred, `tool.execute.after` appends its advisory to the tool result.

## Data handling

The local PreToolUse hook reads the host's JSON event from standard input, including the Bash command and tool description. For supported requests it rewrites top-level `&&` and `;` separators in memory and returns the updated tool input; it does not execute the Bash command. The hook makes no network requests or persistent writes. Subsequent command behavior, including any network access, is determined by the command the host executes.

## Documentation and support

- [Documentation](https://go.vza.net/agent-plugins/command-chain-separator/docs)
- [Support](https://go.vza.net/agent-plugins/command-chain-separator/support)
- [Privacy policy](https://go.vza.net/agent-plugins/command-chain-separator/privacy)
