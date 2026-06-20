# agent-plugins

A Claude Code plugin marketplace of hooks, skills, and commands focused on engineering rigor, GitHub workflow, Windows quirks, and one very specific CAD niche.

## Install

```bash
/plugin marketplace add pedropaulovc/agent-plugins
/plugin install <plugin-name>@agent-plugins
```

## Featured

### [mediocrity-detector](plugins/mediocrity-detector)

Rust `Stop` hook that detects hedging language in the current turn, blocks the stop, and prompts Claude to report each assumption explicitly so you can make the judgement call.

### [unrelated-issue-detector](plugins/unrelated-issue-detector)

Rust `Stop` hook that detects when Claude dismisses findings as unrelated or pre-existing, blocks the stop, and asks for evidence on each dismissal.

### [developing-solidworks](plugins/developing-solidworks)

The only Claude Code skill targeting the SolidWorks .NET COM API. Anti-hallucination guardrails tuned for the low-level surface: many SolidWorks methods take 10–30 positional `bool`/`int`/`double` parameters where a flipped bool silently changes behaviour, so the skill forces named arguments and grounded references to the offline API docs over guesswork. Also: documentation-first workflow, COM-interop code-quality patterns, real-bug learnings (`FeatureCut4` returning null, extrusion failures, faulty-geometry detection), and a `/download-solidworks-docs` command that pulls the offline API doc bundle into the skill folder.

### [alt-text](plugins/alt-text)

Skill for writing social-media alt text that a screen reader user would actually want to hear. Pushes back on the default AI failure mode — exhaustive, forensic descriptions that read like a deposition — and instead frames every image around "what would the post lose if the image disappeared?". Bakes in platform-specific length budgets (Bluesky 2k, Mastodon 1.5k, X 1k, LinkedIn 120), forces transcription of any visible text (memes, tweet screenshots, chart labels), leads with the takeaway for charts, and avoids the common pitfalls of assigning identity from appearance and editorializing ("beautiful", "stunning").

## All plugins

### General-purpose

Broadly useful regardless of what you're working on.

| Plugin | Type | What it does |
|---|---|---|
| [superpowers](plugins/superpowers) | Skills | Core skills library — TDD, debugging, collaboration patterns (vendored from [obra/superpowers](https://github.com/obra/superpowers)) |
| [windows-bash-guard](plugins/windows-bash-guard) | Hook | Auto-fixes Windows+bash path pitfalls (backslash paths, `/dev/stdin`) before execution |
| [memory-to-repo](plugins/memory-to-repo) | Hook | Blocks CRUD on the machine-local auto-memory dir and redirects to the repo's `./memory/` folder so memory is git-tracked and shareable |

### Personalized

Tuned to my own setup, tooling, workflow preferences, or niche — unlikely to appeal to a broad audience.

| Plugin | Type | What it does |
|---|---|---|
| [mediocrity-detector](plugins/mediocrity-detector) | Hook | Detects hedging on `Stop` and pushes back |
| [unrelated-issue-detector](plugins/unrelated-issue-detector) | Hook | Demands evidence for each "unrelated/pre-existing" dismissal |
| [gh-issue](plugins/gh-issue) | Skill | Turns terse bug reports into well-structured GitHub issues via `gh` |
| [pr-comments](plugins/pr-comments) | Skill | Fetches unresolved PR comments formatted for LLM review and reply |
| [command-chain-separator](plugins/command-chain-separator) | Hook | Injects a visible separator between Bash commands joined by `&&` or `;` so per-command output is easy to read |
| [developing-solidworks](plugins/developing-solidworks) | Skill + Command | C#/SolidWorks .NET COM API workflow with anti-hallucination guardrails |
| [gstack-entrepreneur](plugins/gstack-entrepreneur) | Skills | Entrepreneurship subset of gstack: idea validation, market research, strategy (no code) |
| [no-fetch](plugins/no-fetch) | Hook | Blocks `WebFetch` and redirects to my Firecrawl + Browserbase MCPs |
| [worktree-reset](plugins/worktree-reset) | Skill | `/m` — tears down agent state (tasks/timers/teammates/subagents/monitors/loops), resets the current worktree to `origin/main`, and reinstalls deps; `--force` to discard everything |
| [playwright-cli-headed](plugins/playwright-cli-headed) | Hook | Auto-injects `--headed` into `playwright-cli open` invocations and recommends a standard viewport |
| [alt-text](plugins/alt-text) | Skill | Writes accessibility-focused alt text for images about to be posted on social media |

## License

MIT
