# windows-bash-guard plugin
![Windows Bash guard icon](icon.svg)

A Windows-only Bash PreToolUse hook that passes the tool input to a local Rust helper and applies two narrowly scoped command rewrites before execution.

**Rewrites:**
1. In a command string containing `node`, exact quoted `/dev/stdin`, `/dev/stdout`, and `/dev/stderr` literals become file descriptors `0`, `1`, and `2`.
2. Matched drive-letter paths with supported path characters have backslash separators converted to forward slashes. It does not normalize every Windows path form or paths with unsupported characters.

**Harness behavior:**
- Claude Code receives `updatedInput` and `additionalContext` when a rewrite applies; the hook does not grant approval.
- Codex rewrites only when approval is already skipped (`bypassPermissions` or `dontAsk`); otherwise it leaves the command unchanged.
- OpenCode runs the Windows binary before Bash execution, updates the arguments, and appends the explanation to the tool result.
- The exact, case-sensitive text `[no-rewrite]` in the Bash tool description bypasses rewriting.

## Build

The plugin ships x86_64 Linux and Windows executables in `hooks/bin`; the Linux helper exits without rewriting. To rebuild them, use Rust/Cargo and the cross-compilation prerequisites in `hooks/build-hooks.py`; the script writes the generated binaries and executable mode into the plugin.

```bash
python3 hooks/build-hooks.py
```

## CLAUDE.md guidance for Windows+bash users

Add the following optional guidance to `~/.claude/CLAUDE.md` if useful. It is advice for the agent, not a promise that the hook rewrites every path rule shown here.

````
### Windows path guidance

**In common Windows Bash, Node.js, and Python path contexts, forward slashes avoid many escaping problems.** Backslashes can be transformed across bash → JS → filesystem layers.

```
# YES — forward slashes everywhere
node run.js "C:/Users/pedro/file.js"
node -e "require('fs').readFileSync('C:/src/data.json','utf8')"
ls -la "C:/src/project"

# NO — backslashes get mangled
node run.js "C:\\Users\\pedro\\file.js"    # bash eats \U → node gets C:Userspedrofile.js
node -e "readFileSync('C:\\tmp\\file')"    # \t = tab, \f = form feed in JS
ls -la "C:\src\styles\"                     # trailing \" eats closing quote → EOF error
```

Specific failure modes that backslashes cause:
- **Unquoted `C:\src`** → bash interprets `\s` as escape → `C:src` (ENOENT)
- **`node -e` with `C:\tmp`** → JS interprets `\t` as tab → corrupted path (ENOENT)
- **Trailing `"C:\path\"`** → `\"` eats the closing quote → `unexpected EOF`
- **Double-escaped `C:\\\\src`** in node -e → multi-layer escaping hell

Other Windows+bash pitfalls to avoid (these are guidance only; the hook does not rewrite all of them):
- **`/dev/stdin` does not exist on Windows.** Use `readFileSync(0)` (fd 0) instead of `readFileSync('/dev/stdin')`. Same for stdout (fd 1) and stderr (fd 2).
- **`$variable` in `node -e` double quotes** → bash expands `$metadata` to empty string. Use single quotes for the outer shell quoting, or escape as `\$`.
- **MSYS2-style `/c/...` paths may not work when passed to native Windows Node.** Use `C:/...` in that context.
- **Inside JS/TS source files**, use forward-slash paths: `'C:/Users/pedro/file.txt'`. Node.js handles them natively on Windows.
````

## Data handling

The runtime receives the current Bash tool input from the agent host through local stdin (OpenCode passes its Bash arguments directly), checks the command and relevant hook fields, and returns a rewritten command and explanation only when one of the supported patterns matches. The runtime does not read transcripts, write persistent files, or contact a network service. The host controls how tool inputs and returned context are handled afterward.

Separate, manually invoked analysis utilities can read transcript JSONL files from directories you provide and write local test-case data containing commands, error excerpts, categories, transcript filenames, timestamps, and working directories. They are not called during normal hook execution. The build script and optional helper-package setup may resolve build-time dependencies through your configured package registries.

## Plugin resources

[Documentation](https://go.vza.net/agent-plugins/windows-bash-guard/docs) · [Support](https://go.vza.net/agent-plugins/windows-bash-guard/support) · [Privacy](https://go.vza.net/agent-plugins/windows-bash-guard/privacy) · [Local privacy notice](PRIVACY.md)
