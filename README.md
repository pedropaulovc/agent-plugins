# personal-marketplace

A Claude Code plugin marketplace of hooks, skills, and commands focused on engineering rigor, GitHub workflow, Windows quirks, and one very specific CAD niche.

## Install

```bash
/plugin marketplace add pedropaulovc/personal-marketplace
/plugin install <plugin-name>@personal-marketplace
```

## Featured

### [mediocrity-detector](plugins/mediocrity-detector)

Rust `Stop` hook that detects hedging language in the current turn, blocks the stop, and prompts Claude to report each assumption explicitly so you can make the judgement call.

### [unrelated-issue-detector](plugins/unrelated-issue-detector)

Rust `PostToolUse` hook that detects when Claude dismisses findings as unrelated or pre-existing and asks for evidence on each dismissal.

### [developing-solidworks](plugins/developing-solidworks)

The only Claude Code skill targeting the SolidWorks .NET COM API. Anti-hallucination guardrails tuned for the low-level surface: many SolidWorks methods take 10–30 positional `bool`/`int`/`double` parameters where a flipped bool silently changes behaviour, so the skill forces named arguments and grounded references to the offline API docs over guesswork. Also: documentation-first workflow, COM-interop code-quality patterns, real-bug learnings (`FeatureCut4` returning null, extrusion failures, faulty-geometry detection), and a `/download-solidworks-docs` command that pulls the offline API doc bundle into the skill folder.

## All plugins

| Plugin | Type | What it does |
|---|---|---|
| [mediocrity-detector](plugins/mediocrity-detector) | Hook | Detects hedging on `Stop` and pushes back |
| [unrelated-issue-detector](plugins/unrelated-issue-detector) | Hook | Demands evidence for each "unrelated/pre-existing" dismissal |
| [developing-solidworks](plugins/developing-solidworks) | Skill + Command | C#/SolidWorks API workflow |
| [powershell-autofix](plugins/powershell-autofix) | Hook | Auto-appends `\| Out-Host` to fix [claude-code#59609](https://github.com/anthropics/claude-code/issues/59609) |
| [no-fetch](plugins/no-fetch) | Hook | Blocks `WebFetch` and redirects to Firecrawl + Browserbase MCPs |
| [gh-issue](plugins/gh-issue) | Skill | Turns terse bug reports into well-structured GitHub issues via `gh` |
| [pr-comments](plugins/pr-comments) | Skill | Fetches unresolved PR comments formatted for LLM review and reply |
| [worktree-reset](plugins/worktree-reset) | Skill | `/m` — resets the current worktree to `origin/main` and reinstalls deps |
| [gstack-entrepreneur](plugins/gstack-entrepreneur) | Skills | Entrepreneurship subset of gstack: idea validation, market research, strategy (no code) |

## License

MIT
