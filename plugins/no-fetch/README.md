# no-fetch plugin

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

If the agent is genuinely restricted to the fetch tool with no MCP alternative, it can add `[force-fetch]` to the `WebFetch` `url` (the tool's main string field) to bypass the block. The hook strips the marker from the request before the fetch runs, so it never reaches the network as part of the URL. This is reserved for worst-case situations — it is not a routine way to skip the routing above.

## Requirements

The Firecrawl and Browserbase MCP servers must be configured in your Claude Code MCP settings. Without them this hook will block fetches without providing a working alternative.

## License

MIT
