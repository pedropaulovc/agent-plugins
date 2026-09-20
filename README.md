# agent-plugins

A collection of Claude Code, OpenAI Codex, and OpenCode plugins for engineering work, GitHub workflows, Windows tooling, and SolidWorks development.

## Installation

### Claude Code

```bash
/plugin marketplace add pedropaulovc/agent-plugins
/plugin install <plugin-name>@agent-plugins
```

### OpenAI Codex CLI

Every plugin except `no-fetch` is available from the Codex marketplace:

```bash
codex plugin marketplace add pedropaulovc/agent-plugins
```

Enable plugins from the `/plugins` browser. `no-fetch` is Claude-only because Codex routes web access through a hosted `web_search` tool that hooks cannot intercept. Disable that tool by setting `web_search = "disabled"` in `~/.codex/config.toml`.

Slash commands appear as skills in Codex. Invoke them with `$<skill>` or from `/skills`.

### OpenCode

Install the collection by adding its Git package to the `plugin` array in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "agent-plugins@git+https://github.com/pedropaulovc/agent-plugins.git"
  ]
}
```

Restart OpenCode after changing the config. The package registers the bundled skills, commands, lifecycle hooks, and tool hooks. The [OpenCode guide](docs/opencode.md) covers selective local installs, platform support, and hook mappings.

## Selected plugins

### [mediocrity-detector](plugins/mediocrity-detector)

Blocks an agent from ending its turn when the turn contains hedging and asks it to state each assumption so you can make the call.

### [unrelated-issue-detector](plugins/unrelated-issue-detector)

Blocks an agent from ending its turn when it dismisses a finding as unrelated or pre-existing and asks for evidence.

### [developing-solidworks](plugins/developing-solidworks)

Guides C# development against the SolidWorks .NET COM API using offline documentation and API-specific safeguards. Run `/download-solidworks-docs` to download the API documentation into the skill directory.

### [developing-solidworks-mcp](plugins/developing-solidworks-mcp)

Provides structured SolidWorks XMLDoc search, catalog browsing, and type, enum, example, and guide retrieval. Install this or `developing-solidworks`, not both.

### [alt-text](plugins/alt-text)

Writes accessibility-focused social-media alt text. It transcribes visible text such as memes, tweet screenshots, and chart labels, leads charts with the takeaway, avoids inferring identity from appearance, and omits editorial judgments such as "beautiful" or "stunning." Limits are 2,000 characters on Bluesky, 1,500 on Mastodon, 1,000 on X, and 120 on LinkedIn.

## All plugins

### General purpose

These plugins are useful across projects.

| Plugin | Type | What it does |
|---|---|---|
| [superpowers](plugins/superpowers) | Skills | Skills for TDD, debugging, and collaboration, vendored from [obra/superpowers](https://github.com/obra/superpowers) |
| [windows-bash-guard](plugins/windows-bash-guard) | Hook | Fixes Windows and Bash path pitfalls such as backslash paths and `/dev/stdin` before execution |
| [memory-to-repo](plugins/memory-to-repo) | Hook + Skills | Blocks auto-memory CRUD in the machine-local directory and redirects it to the repository's `./memory/` directory so memory is git-tracked and shareable |

### Plugins for specific tools and workflows

These plugins target specific tools, workflows, or the author's setup. Some require configuration that is not part of this repository.

| Plugin | Type | What it does |
|---|---|---|
| [mediocrity-detector](plugins/mediocrity-detector) | Hook | Detects hedging on `Stop` and asks the agent to state its assumptions |
| [unrelated-issue-detector](plugins/unrelated-issue-detector) | Hook | Requires evidence when an agent dismisses a finding as unrelated or pre-existing |
| [gh-issue](plugins/gh-issue) | Skill | Turns terse bug reports into structured GitHub issues through `gh` |
| [pr-comments](plugins/pr-comments) | Skill | Fetches unresolved PR comments for review and reply |
| [watch-pr](plugins/watch-pr) | MCP Server + Skill + Watcher | `/watch-pr` keeps one long-lived, same-session watcher on durable GitHub PR events and acts on CI, rebases, reviews, feedback, and merge or closure |
| [omp-persist-system-prompt](plugins/omp-persist-system-prompt) | OMP Extension | Makes effective system prompts and provider tool context available for transcript indexing |
| [command-chain-separator](plugins/command-chain-separator) | Hook | Adds a visible separator between Bash commands joined by `&&` or `;` so each command's output is easy to read |
| [developing-solidworks](plugins/developing-solidworks) | Skill + Command | Guides C# development against the SolidWorks .NET COM API |
| [developing-solidworks-mcp](plugins/developing-solidworks-mcp) | MCP Server + Skill | Searches SolidWorks XMLDoc and retrieves type, enum, example, and guide records |
| [gstack-entrepreneur](plugins/gstack-entrepreneur) | Skills | Provides gstack's no-code entrepreneurship skills for idea validation, market research, and strategy |
| [no-fetch](plugins/no-fetch) | Hook | Blocks `WebFetch` and redirects requests to separately configured Firecrawl and Browserbase MCP servers |
| [worktree-reset](plugins/worktree-reset) | Skill | `/reset` runs harness-aware teardown, resets the current worktree to `origin/main`, and syncs Node, Go, and Python dependencies |
| [playwright-cli-headed](plugins/playwright-cli-headed) | Hook | Adds `--headed` to `playwright-cli open` and recommends a standard viewport |
| [alt-text](plugins/alt-text) | Skill | Writes alt text for images that are about to be posted on social media |
| [pedro-microblog](plugins/pedro-microblog) | Skill | Applies Pedro's observed microblog voice across X, Threads, Mastodon, and Bluesky |
| [cloudflare-temp-accounts](plugins/cloudflare-temp-accounts) | Skill | Provisions and claims Cloudflare temporary accounts and isolates Wrangler authentication profiles |
| [onepassword](plugins/onepassword) | Skill | Establishes an interactive 1Password CLI (`op`) session in a tmux pane when service-account authentication fails |

## License

MIT
