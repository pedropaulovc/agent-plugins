# developing-solidworks

![Developing SolidWorks plugin icon](./icon.svg)

An agent skill for writing, modifying, and debugging SolidWorks COM automation—primarily in C#/.NET, and also in C++, VBA, Python (pywin32/comtypes), PowerShell, and VB.NET.

## What it does

The skill targets `.cs`, `.csproj`, and `.sln` paths; its description also covers SolidWorks automation and API questions involving other COM-capable languages. It gives the agent:

- A documentation-first workflow (read first, code second, **run** before claiming success)
- Shell `rg --no-ignore` recipes for navigating the API reference; the skill notes that the host Grep/Glob tools cannot search the bundled documentation
- Code-quality rules tuned for SolidWorks: named parameters, null-check discipline, enum/interface casting patterns
- A `learnings/` directory with documented fixes for real problems (`FeatureCut4` returning null, extrusion failures, faulty-geometry detection, broken-mate detection via `GetWhatsWrong`)
- A `scripts/find_api_redist.py` helper that searches for `SOLIDWORKS/api/redist` under `C:\Program Files\Dassault Systemes` by default and returns the match with the newest parent-directory modification time

## Slash commands

- **`/download-solidworks-docs [skill-dir]`** — Downloads the latest SolidWorks API doc bundle from [pedropaulovc/offline-solidworks-api-docs](https://github.com/pedropaulovc/offline-solidworks-api-docs) and unpacks it into the skill folder (`skills/developing-solidworks/`). Run this once after installing the plugin so the `types/`, `enums/`, `docs/`, `examples/`, and `index/` directories the skill recipes expect exist. Pass the absolute skill-directory path as an argument; if omitted, the downloader skill resolves its sibling copy and can search both `~/.claude/plugins` and `~/.codex/plugins`. It does not rely on `CLAUDE_PLUGIN_ROOT` in the shell. The downloader retrieves the latest `*llms.v*.zip` release asset and uses 7-Zip if `7z`/`7za` is on `PATH` or under either `Program Files` tree; otherwise it falls back to `Expand-Archive`.

## Versioned doc tree (gitignored)

The doc tree (`types/`, `enums/`, `docs/`, `examples/`, `index/`) is excluded from version control via the skill's `.gitignore` because it's large and version-specific. Always populate it via `/download-solidworks-docs` after install or after a SolidWorks SDK upgrade.

## Requirements

- SolidWorks installed locally to run and verify COM automation; the helper defaults to `C:\Program Files\Dassault Systemes` (or a root supplied by its caller)
- The .NET Interop workflow uses .NET Framework; other COM-capable languages are also supported
- `dotnet` on `PATH` for the .NET workflow; use an appropriate runner for other supported languages

## Codex and OpenCode support

Works in both. Under Codex, invoke the bundled `download-solidworks-docs` skill with `$download-solidworks-docs` (it invokes the checked-in PowerShell script) — the Claude `Skill()` tool call in the setup steps is Claude-Code-specific.

Under OpenCode, use `/download-solidworks-docs`; the adapter registers both bundled skills and the command.

## Data handling

The skill guides agents working with local project files and SolidWorks automation; the host may include relevant code, prompts, and tool results in its conversation. The skill also directs a once-per-session `curl` request to the GitHub Releases API for `pedropaulovc/offline-solidworks-api-docs` to check the bundle version. Its download command retrieves the latest `*llms.v*.zip` release asset and extracts that documentation into the local skill directory. These requests fetch reference documentation; the downloader does not upload the user's source project. An agent may separately read or run project code when asked, so resulting file or SolidWorks changes depend on the commands used.

## Documentation and support

- [Documentation](https://go.vza.net/agent-plugins/developing-solidworks/docs)
- [Support](https://go.vza.net/agent-plugins/developing-solidworks/support)
- [Privacy policy](https://go.vza.net/agent-plugins/developing-solidworks/privacy)
