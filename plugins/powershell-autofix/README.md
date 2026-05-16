# powershell-autofix

PreToolUse hook for Claude Code that auto-appends `| Out-String` to PowerShell commands whose output would otherwise be silently swallowed.

## The bug it works around

Filed upstream as [anthropics/claude-code#59609](https://github.com/anthropics/claude-code/issues/59609).

When you invoke the Claude Code `PowerShell` tool with a command that ends in something like `Get-Process | Select-Object Id, ProcessName`, PowerShell emits an object stream that *would* be rendered to text by the default formatter in an interactive `pwsh` session. The Claude Code tool wrapper doesn't run the default formatter, so the user (and the model) see:

```
(PowerShell completed with no output)
```

…which looks identical to "no matching results" or "command failed silently."

Appending `| Out-String` to the same command makes the output appear correctly. This plugin does that automatically.

## How it works

`PreToolUse` is registered for `matcher: "PowerShell"`. When Claude attempts to run a PowerShell command, the hook:

1. Inspects the command string.
2. Runs `needs_out_string(command)` — a heuristic that decides whether the command's final pipeline stage would emit unrendered objects.
3. If yes, returns `hookSpecificOutput.updatedInput` with `command` rewritten to `<command> | Out-String`. The tool then executes the fixed command.
4. If no, the hook is a silent no-op.

The fix is intentionally additive — it never blocks the call.

## Installation

This plugin is registered in the parent `personal-marketplace`. Once the marketplace is added to your Claude Code configuration, install with:

```
/plugin add powershell-autofix@personal-marketplace
```

The hook is a small cross-compiled Rust binary (`hooks/bin/powershell-autofix[.exe]`) — no Python or other runtime dependency at install time. After changes to the source, rebuild with:

```
python3 plugins/powershell-autofix/hooks/build-hooks.py
```

## Files

- `.claude-plugin/plugin.json` — plugin manifest.
- `hooks/hooks.json` — registers the PreToolUse hook on the `PowerShell` matcher; selects the `.exe` on Windows and the ELF binary elsewhere.
- `hooks/powershell-autofix/` — Rust crate source.
- `hooks/bin/` — compiled binaries (Linux + Windows), committed so the plugin works without a Rust toolchain on install.
- `hooks/build-hooks.py` — cross-compile script.
