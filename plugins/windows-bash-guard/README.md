# windows-bash-guard plugin

A Rust PreToolUse hook that auto-fixes common Windows+bash path pitfalls before execution, avoiding wasted round-trips.

**Fixes applied:**
1. `/dev/stdin` → fd `0` in node commands (doesn't exist on Windows)
2. Backslash drive paths → forward slashes everywhere (fixes unquoted paths, `node -e` escape bugs, and trailing `\"` in one pass)

**Behavior:**
- Returns `updatedInput` with the corrected command so Claude Code executes it transparently
- Injects `additionalContext` so Claude sees what was changed and learns to avoid the pattern
- Claude can bypass rewriting by adding `[no-rewrite]` to the Bash tool description

## Build

```
python3 hooks/build-hooks.py
```

## CLAUDE.md guidance for Windows+bash users

Add the following to your `~/.claude/CLAUDE.md` to prevent path-related failures. This guidance is based on analysis of ~6000 real-world Bash tool failures from Claude Code transcripts.

````markdown
### Windows path rules (CRITICAL — most common source of bash failures)

**Always use forward slashes in paths.** Forward slashes work everywhere on Windows: bash, Node.js, Python, and Windows APIs. Backslashes cause cascading escaping failures across bash → JS → filesystem layers.

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

Other Windows+bash pitfalls:
- **`/dev/stdin` does not exist on Windows.** Use `readFileSync(0)` (fd 0) instead of `readFileSync('/dev/stdin')`. Same for stdout (fd 1) and stderr (fd 2).
- **`$variable` in `node -e` double quotes** → bash expands `$metadata` to empty string. Use single quotes for the outer shell quoting, or escape as `\$`.
- **MSYS2 paths don't work in Node**: `node run.js /c/Users/pedro/file.js` fails — use `C:/Users/pedro/file.js` instead.
- **Inside JS/TS source files**, use forward-slash paths: `'C:/Users/pedro/file.txt'`. Node.js handles them natively on Windows.
````

## Codex and OpenCode support

Windows only (both harnesses). **Codex:** rewriting requires `permissionDecision: "allow"` (which skips approval), so the hook only rewrites in `bypassPermissions`/`dontAsk` modes; it also ships a `commandWindows` override so Codex-on-Windows launches the binary directly.

**OpenCode:** runs the Windows binary from `tool.execute.before`, mutates Bash arguments without bypassing permissions, and appends the rewrite explanation to the result.
