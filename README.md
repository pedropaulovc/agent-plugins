# personal-marketplace

Personal plugin marketplace for Claude Code agents.

## Installation

Add this marketplace to your Claude Code configuration:

```bash
/plugin marketplace add pedropaulovc/agents-plugins
/plugin add pedropaulovc@agents-plugins
```

## Available Plugins

### pedropaulovc (v1.0.0)

Personal productivity plugins for daily development workflows.

**Commands:**
- `/comments` - Fetch PR comments for LLM consumption
- `/m` - Reset worktree to origin/main

**Skills:**
- `issue/` - Create well-structured GitHub issues

### superpowers (v4.1.1)

Fork of [Superpowers](https://github.com/obra/superpowers) - A complete software development workflow for your coding agents, built on top of a set of composable "skills" and some initial instructions that make sure your agent uses them.

### developing-solidworks (v0.1.0)

C# + SolidWorks API skill: documentation-first workflow, code-quality patterns for COM interop, learnings from real bugs (`FeatureCut4` returning null, extrusion failures, faulty geometry), and a `/download-solidworks-docs` command that fetches the offline API doc bundle into the skill folder. Extracted from [pedropaulovc/harmonic-analyzer](https://github.com/pedropaulovc/harmonic-analyzer).

### powershell-autofix (v0.1.0)

PreToolUse hook that auto-appends `| Out-String` to PowerShell commands whose output would otherwise be silently dropped by the Claude Code PowerShell tool (see [anthropics/claude-code#59609](https://github.com/anthropics/claude-code/issues/59609)). Lets the model run idiomatic PowerShell one-liners without defensively tacking on `Format-Table`.

## License

MIT
