---
name: download-solidworks-docs
description: Windows/PowerShell — download and unpack the latest offline SolidWorks API documentation bundle into the developing-solidworks skill folder so the main skill can serve docs locally.
---

# Download SolidWorks API docs

Download and unpack the latest offline SolidWorks API documentation bundle from
GitHub releases into the `developing-solidworks` skill folder (the main skill in
this same plugin, at `skills/developing-solidworks/` under the plugin root). This
is a **Windows / PowerShell** task.

## Resolve the target directory

Before running the script, determine the absolute path of the sibling
`developing-solidworks` skill directory and pass it to the script as `-TargetDir`:

- This skill's own file lives at `skills/download-solidworks-docs/SKILL.md` under
  the plugin root. Its sibling — the main skill — is `skills/developing-solidworks/`
  under the same plugin root. Resolve that absolute path from this skill's location
  (Codex tells you this skill's file path when it loads the skill).
- If you cannot resolve it that way, fall back to searching for a
  `*/skills/developing-solidworks` directory under BOTH `~/.claude/plugins` and
  `~/.codex/plugins`.

## Run the script

Invoke the checked-in PowerShell script rather than pasting an inline block. This
keeps the download operation compatible with shell policies that reject inline
multi-line scripts:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:/path/to/developing-solidworks/skills/download-solidworks-docs/scripts/download-solidworks-docs.ps1" -TargetDir "C:/path/to/developing-solidworks/skills/developing-solidworks"
```

The script resolves the latest GitHub release, downloads its single `*llms.v*.zip`
asset, extracts it with 7-Zip when available (otherwise `Expand-Archive`), writes
`.bundle-version`, and removes the temporary archive. Report the version that was
unpacked and the target directory.
