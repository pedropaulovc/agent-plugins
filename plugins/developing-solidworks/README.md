# developing-solidworks

A Claude Code skill for writing, modifying, and debugging C# code that talks to the SolidWorks API via COM interop.

## What it does

Auto-activates whenever you're touching `.cs` / `.csproj` files that reference the SolidWorks SDK or `SolidWorks.Interop.*` assemblies, and gives the agent:

- A documentation-first workflow (read first, code second, **run** before claiming success)
- Grep recipes for navigating the (large) SolidWorks API reference once it's downloaded into the skill folder
- Code-quality rules tuned for SolidWorks: named parameters, null-check discipline, enum/interface casting patterns
- A `learnings/` directory with documented fixes for real problems (`FeatureCut4` returning null, extrusion failures, faulty-geometry detection, broken-mate detection via `GetWhatsWrong`)
- A `scripts/find_api_redist.py` helper that locates the latest installed `SolidWorks.Interop.*` redistributable folder

## Slash commands

- **`/download-solidworks-docs`** — Downloads the latest SolidWorks API doc bundle from [pedropaulovc/offline-solidworks-api-docs](https://github.com/pedropaulovc/offline-solidworks-api-docs) and unpacks it into the skill folder (`$CLAUDE_PLUGIN_ROOT/skills/developing-solidworks/`). Run this once after installing the plugin so the `types/`, `enums/`, `docs/`, `examples/`, and `index/` directories the skill grep recipes expect actually exist. **Currently requires 7-Zip at `C:\Program Files\7-Zip\7z.exe`** — that hardcoded path is inherited from the source repo and not yet portable.

## Versioned doc tree (gitignored)

The doc tree (`types/`, `enums/`, `docs/`, `examples/`, `index/`) is excluded from version control via the skill's `.gitignore` because it's large and version-specific. Always populate it via `/download-solidworks-docs` after install or after a SolidWorks SDK upgrade.

## Requirements

- SolidWorks installed locally (the helper script searches the standard install paths)
- .NET Framework (the SolidWorks SDK is .NET Framework only — not .NET Core/5+)
- `dotnet` on `PATH` for the run-before-claiming-success workflow

## Source

Extracted from [pedropaulovc/harmonic-analyzer](https://github.com/pedropaulovc/harmonic-analyzer)'s `cad/.claude/skills/developing-solidworks/`.
