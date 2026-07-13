# playwright-cli-headed plugin

A Rust PreToolUse hook for **Bash** and **PowerShell** tool calls that auto-injects `--headed` into any `playwright-cli open` invocation that is missing it, and reminds Claude to set a standard viewport size before screenshotting.

**Why:** when Claude drives Playwright through `playwright-cli open`, the browser must be visible so the user can actually see what's happening. Headless invocations defeat the point and silently change behavior. This hook enforces `--headed` without a wasted round-trip and surfaces a screenshot-compatibility tip.

**Behavior:**
- Detects `playwright-cli ... open ...` invocations at word boundaries (handles full paths like `/usr/local/bin/playwright-cli`, env prefixes like `DEBUG=1 playwright-cli ...`, and chained statements like `echo hi && playwright-cli open ...`)
- If `--headed` (or `--headed=...`) is missing, splices ` --headed` immediately after the `open` token, leaving the rest of the command byte-for-byte unchanged → returns `updatedInput` so Claude Code executes the corrected command transparently
- Whenever `playwright-cli open` is detected (rewrite or not), injects an `additionalContext` system reminder recommending `playwright-cli resize 1600 900` for consistent screenshot dimensions
- Bypass rewriting (but not the tip): add `[no-rewrite]` to the tool description

**Skipped cases (no rewrite):**
- `--headed` already present (anywhere in the invocation, including `--headed=true`)
- Subcommand is not `open` (e.g. `playwright-cli codegen ...`)
- A different binary (`playwright`, `npx playwright`) — only the literal `playwright-cli` is matched
- `open` appears only inside a quoted token (e.g. a URL path)

## Build

```
python3 hooks/build-hooks.py
```

Cross-compiles the Rust binary for Linux x86_64 and Windows x86_64 and copies the outputs to `hooks/bin/`. Run after any change to the Rust source or when bumping the plugin version.

## Codex and OpenCode support

Works in both. **Codex:** like the other rewrite hooks, injecting `--headed` requires `permissionDecision: "allow"` (which skips approval), so the hook only rewrites in `bypassPermissions`/`dontAsk` modes and stays inert in approval-requiring modes.

**OpenCode:** mutates Bash/PowerShell arguments without changing its permission flow and appends the viewport recommendation to the tool result.
