# developing-solidworks

An agent skill for writing, modifying, and debugging C# code that talks to the SolidWorks API via COM interop.

## What it does

Auto-activates whenever you're touching `.cs` / `.csproj` files that reference the SolidWorks SDK or `SolidWorks.Interop.*` assemblies, and gives the agent:

- A documentation-first workflow (read first, code second, **run** before claiming success)
- Grep recipes for navigating the (large) SolidWorks API reference once it's downloaded into the skill folder
- Code-quality rules tuned for SolidWorks: named parameters, null-check discipline, enum/interface casting patterns
- A `learnings/` directory with documented fixes for real problems (`FeatureCut4` returning null, extrusion failures, faulty-geometry detection, broken-mate detection via `GetWhatsWrong`)
- A `scripts/find_api_redist.py` helper that locates the latest installed `SolidWorks.Interop.*` redistributable folder

## Slash commands

- **`/download-solidworks-docs [skill-dir]`** — Downloads the latest SolidWorks API doc bundle from [pedropaulovc/offline-solidworks-api-docs](https://github.com/pedropaulovc/offline-solidworks-api-docs) and unpacks it into the skill folder (`skills/developing-solidworks/`). Run this once after installing the plugin so the `types/`, `enums/`, `docs/`, `examples/`, and `index/` directories the skill grep recipes expect actually exist. Pass the absolute skill-directory path as an argument; if omitted, the command searches `~/.claude/plugins` to locate it. (It does **not** rely on `CLAUDE_PLUGIN_ROOT`, which Claude Code only exports to hook/MCP/LSP subprocesses, not to the shell this script runs in.) For unpacking it uses 7-Zip if `7z`/`7za` is on `PATH` or installed under either `Program Files` tree, otherwise it falls back to the slower built-in `Expand-Archive`.

## Versioned doc tree (gitignored)

The doc tree (`types/`, `enums/`, `docs/`, `examples/`, `index/`) is excluded from version control via the skill's `.gitignore` because it's large and version-specific. Always populate it via `/download-solidworks-docs` after install or after a SolidWorks SDK upgrade.

## Requirements

- SolidWorks installed locally (the helper script searches the standard install paths)
- .NET Framework (the SolidWorks SDK is .NET Framework only — not .NET Core/5+)
- `dotnet` on `PATH` for the run-before-claiming-success workflow

## Source

Extracted from [pedropaulovc/harmonic-analyzer](https://github.com/pedropaulovc/harmonic-analyzer)'s `cad/.claude/skills/developing-solidworks/`.

## Codex and OpenCode support

Works in both. Under Codex, invoke the bundled `download-solidworks-docs` skill with `$download-solidworks-docs` (or run its PowerShell block directly) — the Claude `Skill()` tool call in the setup steps is Claude-Code-specific.

Under OpenCode, use `/download-solidworks-docs`; the adapter registers both bundled skills and the command.
