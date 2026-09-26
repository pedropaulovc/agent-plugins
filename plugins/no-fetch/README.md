![no-fetch icon](icon.svg)

# no-fetch plugin

[Documentation](https://go.vza.net/agent-plugins/no-fetch/docs) · [Support](https://go.vza.net/agent-plugins/no-fetch/support) · [Privacy](https://go.vza.net/agent-plugins/no-fetch/privacy) · [Local privacy details](PRIVACY.md)

A `PreToolUse` hook that blocks Claude Code's built-in `WebFetch` tool and redirects the agent to [Firecrawl](https://www.firecrawl.dev) + [Browserbase](https://www.browserbase.com) MCP tools, which are substantially more reliable against sites with anti-bot protection, paywalls, JS-rendering, or CAPTCHA.

## Why

`WebFetch` works fine on plain HTML but fails silently or returns thin content on a large fraction of the modern web. The agent often accepts that result and moves on. This hook closes that escape hatch — every `WebFetch` call is converted into a hard block with a routing message that tells the agent exactly which MCP tool to use instead, and explicitly forbids fabricating around the gap.

## Behavior

When the agent calls `WebFetch`, the hook returns a `block` decision with routing guidance:

- **READ** (one page, search, crawl, schema extraction) → `firecrawl_{scrape,search,map,crawl,extract,...}`
- **INTERACT** (login, multi-step click/fill, persistent page state) → `browserbase_{start,navigate,observe,act,extract,end}`
- **FALLBACK** when both fail → Playwright (always `--headed`) → Claude in Chrome

## Exclusions

Some targets are served cleanly by plain `WebFetch` and gain nothing from the MCP tools, so the hook lets them through unblocked:

- **GitHub** — `github.com`, `*.githubusercontent.com` (raw files), `*.github.io` pages, and the API.
- **Claude / Anthropic** — `anthropic.com`, `claude.com`, `claude.ai`, and their subdomains (docs, API).
- **Agent manifests** — any URL ending in `/llms.txt` or `/llms-full.txt`.

## Escape hatch

If the agent is genuinely restricted to the fetch tool with no MCP alternative, it can add `[force-fetch]` to the `WebFetch` `url` (the tool's main string field) to bypass the block. The OpenCode callback strips the marker directly. In Claude Code, `jq` must be available on `PATH` for the hook to emit the marker-stripped `updatedInput`; without it, the hook does not provide an updated input, so do not rely on this bypass. This is reserved for worst-case situations — it is not a routine way to skip the routing above.

## Requirements

The Firecrawl and Browserbase MCP servers must be configured in your Claude Code or OpenCode MCP settings. Without them this hook will block fetches without providing a working alternative. `jq` is needed on Claude Code only if you use the `[force-fetch]` escape hatch.

## License

MIT

## Codex and OpenCode support

**Claude Code only.** Deliberately not shipped to Codex: Codex has no `WebFetch` tool to intercept, and its `web_search` is not hook-interceptable. To force MCP tools under Codex, set `web_search = "disabled"` in `~/.codex/config.toml` instead.

OpenCode is supported through `tool.execute.before`: its `webfetch` tool is denied with the same routing guidance, exclusions, and `[force-fetch]` escape hatch.

## Operations and data

The local hook receives WebFetch input, checks the URL against its exclusions, and either
allows the request or blocks it with routing guidance. It does not perform the fetch or
call Firecrawl, Browserbase, Playwright, or another service itself. The `[force-fetch]`
marker is stripped by OpenCode's callback, or by Claude Code when `jq` is available and
the hook can return an updated input.

If the agent follows the guidance, the selected WebFetch or MCP integration receives the
URL and any accompanying search or interaction data; those providers and visited sites
handle it under their own policies. The hook has no telemetry sender or persistent store.
