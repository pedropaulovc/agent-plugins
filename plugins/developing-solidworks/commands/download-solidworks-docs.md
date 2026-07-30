---
description: Download and unpack the latest SolidWorks API documentation into the developing-solidworks skill folder
---

Download and unpack the latest SolidWorks API documentation from GitHub releases
by invoking the checked-in script. Do not paste the downloader as an inline
multi-line PowerShell command: shell policy may reject it.

Resolve the absolute path of the plugin's
`skills/download-solidworks-docs/scripts/download-solidworks-docs.ps1` and invoke
it with the absolute path of the sibling `skills/developing-solidworks` directory:

```powershell
& $scriptPath -TargetDir $targetDir
```

If the command receives a skill-directory argument, use it as `$targetDir`.
Otherwise resolve the installed plugin copy under `~/.claude/plugins` or
`~/.codex/plugins`. Report the version unpacked and the target directory.
