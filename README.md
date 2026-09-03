# agent-plugins

A Claude Code, OpenAI Codex, and OpenCode collection of hooks, skills, and commands focused on engineering rigor, GitHub workflow, Windows quirks, and one very specific CAD niche.

## Install

**Claude Code:**

```bash
/plugin marketplace add pedropaulovc/agent-plugins
/plugin install <plugin-name>@agent-plugins
```

**OpenAI Codex CLI:** every plugin except `no-fetch` ships a `.codex-plugin/plugin.json`
and is listed in `.agents/plugins/marketplace.json`, so Codex loads them from the same repo:

```bash
codex plugin marketplace add pedropaulovc/agent-plugins
```

Then enable plugins from the `/plugins` browser. `no-fetch` is Claude-only — Codex's
web access is a hosted `web_search` tool that hooks can't intercept (disable it with
`web_search = "disabled"` in `~/.codex/config.toml` instead). Slash-commands become
skills under Codex (invoke with `$<skill>` or `/skills`).

**OpenCode:** install the whole collection by adding its Git package to the `plugin`
array in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "agent-plugins@git+https://github.com/pedropaulovc/agent-plugins.git"
  ]
}
```

Restart OpenCode after changing the config. The package registers all bundled skills,
commands, and lifecycle/tool hooks. See [the OpenCode guide](docs/opencode.md) for
selective local installs, platform support, and the hook mapping.

## Featured

### [mediocrity-detector](plugins/mediocrity-detector)

Rust `Stop` hook that detects hedging language in the current turn, blocks the stop, and prompts the agent to report each assumption explicitly so you can make the judgement call.

### [unrelated-issue-detector](plugins/unrelated-issue-detector)

Rust `Stop` hook that detects when the agent dismisses findings as unrelated or pre-existing, blocks the stop, and asks for evidence on each dismissal.

### [developing-solidworks](plugins/developing-solidworks)

The only skill in this collection targeting the SolidWorks .NET COM API. Anti-hallucination guardrails tuned for the low-level surface: many SolidWorks methods take 10–30 positional `bool`/`int`/`double` parameters where a flipped bool silently changes behaviour, so the skill forces named arguments and grounded references to the offline API docs over guesswork. Also: documentation-first workflow, COM-interop code-quality patterns, real-bug learnings (`FeatureCut4` returning null, extrusion failures, faulty-geometry detection), and a `/download-solidworks-docs` command that pulls the offline API doc bundle into the skill folder.


### [developing-solidworks-mcp](plugins/developing-solidworks-mcp)

Standalone MCP server for grounded SolidWorks XMLDoc search, catalog browsing, and complete type, enum, example, and guide retrieval. Use it instead of `developing-solidworks` when structured documentation lookup is needed; do not install both.

### [alt-text](plugins/alt-text)

Skill for writing social-media alt text that a screen reader user would actually want to hear. Pushes back on the default AI failure mode — exhaustive, forensic descriptions that read like a deposition — and instead frames every image around "what would the post lose if the image disappeared?". Bakes in platform-specific length budgets (Bluesky 2k, Mastodon 1.5k, X 1k, LinkedIn 120), forces transcription of any visible text (memes, tweet screenshots, chart labels), leads with the takeaway for charts, and avoids the common pitfalls of assigning identity from appearance and editorializing ("beautiful", "stunning").

## All plugins

### General-purpose

Broadly useful regardless of what you're working on.

| Plugin | Type | What it does |
|---|---|---|
| [superpowers](plugins/superpowers) | Skills | Core skills library — TDD, debugging, collaboration patterns (vendored from [obra/superpowers](https://github.com/obra/superpowers)) |
| [windows-bash-guard](plugins/windows-bash-guard) | Hook | Auto-fixes Windows+bash path pitfalls (backslash paths, `/dev/stdin`) before execution |
| [memory-to-repo](plugins/memory-to-repo) | Hook + Skills | Blocks CRUD on the machine-local auto-memory dir and redirects to the repo's `./memory/` folder so memory is git-tracked and shareable |

### Personalized

Tuned to my own setup, tooling, workflow preferences, or niche — unlikely to appeal to a broad audience.

| Plugin | Type | What it does |
|---|---|---|
| [mediocrity-detector](plugins/mediocrity-detector) | Hook | Detects hedging on `Stop` and pushes back |
| [unrelated-issue-detector](plugins/unrelated-issue-detector) | Hook | Demands evidence for each "unrelated/pre-existing" dismissal |
| [gh-issue](plugins/gh-issue) | Skill | Turns terse bug reports into well-structured GitHub issues via `gh` |
| [pr-comments](plugins/pr-comments) | Skill | Fetches unresolved PR comments formatted for LLM review and reply |
| [watch-pr](plugins/watch-pr) | Skill + Tool | `/watch-pr` — watches a PR's full lifecycle (CI, rebase, reviews, merge), coalesces routine CI check churn, and surfaces deduplicated feedback changes through Claude's Monitor or OpenCode's event-driven `promptAsync` bridge |
| [omp-persist-system-prompt](plugins/omp-persist-system-prompt) | OMP Extension | Stores each distinct effective system prompt plus provider tool context as hidden custom session metadata for transcript indexing |
| [command-chain-separator](plugins/command-chain-separator) | Hook | Injects a visible separator between Bash commands joined by `&&` or `;` so per-command output is easy to read |
| [developing-solidworks](plugins/developing-solidworks) | Skill + Command | C#/SolidWorks .NET COM API workflow with anti-hallucination guardrails |
| [developing-solidworks-mcp](plugins/developing-solidworks-mcp) | MCP Server + Skill | Grounded SolidWorks XMLDoc search, catalog browsing, and complete record retrieval |
| [gstack-entrepreneur](plugins/gstack-entrepreneur) | Skills | Entrepreneurship subset of gstack: idea validation, market research, strategy (no code) |
| [no-fetch](plugins/no-fetch) | Hook | Blocks `WebFetch` and redirects to my Firecrawl + Browserbase MCPs |
| [worktree-reset](plugins/worktree-reset) | Skill | `/reset` — harness-aware teardown, then resets the current worktree to `origin/main` and syncs Node, Go, and Python dependencies |
| [playwright-cli-headed](plugins/playwright-cli-headed) | Hook | Auto-injects `--headed` into `playwright-cli open` invocations and recommends a standard viewport |
| [alt-text](plugins/alt-text) | Skill | Writes accessibility-focused alt text for images about to be posted on social media |
| [cloudflare-temp-accounts](plugins/cloudflare-temp-accounts) | Skill | Provisions and claims Cloudflare temporary accounts, then isolates Wrangler auth profiles |
| [onepassword](plugins/onepassword) | Skill | Establishes a 1Password CLI (`op`) session interactively via tmux when service-account auth fails |

## License

MIT
