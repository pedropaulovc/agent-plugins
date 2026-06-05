#!/bin/sh
input=$(cat)

echo "$input" | grep -q '"tool_name"[[:space:]]*:[[:space:]]*"WebFetch"' || exit 0

# Escape hatch: the agent put [force-fetch] in the prompt — let it through.
# Reserved for the worst cases (e.g. the agent is restricted to the fetch tool
# only and has no MCP alternative); not a routine bypass.
echo "$input" | grep -q '\[force-fetch\]' && exit 0

# Extract the target URL so we can check it against the exclusion list.
url=$(echo "$input" | grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/^"url"[[:space:]]*:[[:space:]]*"//; s/"$//')

# Exclusion list: targets that plain WebFetch serves cleanly and that the MCP
# tools don't improve on.
# - GitHub (repos, raw files, gists, API, *.github.io) returns clean content.
# - llms.txt / llms-full.txt are plain-text agent manifests.
echo "$url" | grep -qiE '://([^/]+\.)?(github\.com|githubusercontent\.com|github\.io)(/|:|$)' && exit 0
echo "$url" | grep -qiE '/llms(-full)?\.txt([?#]|$)' && exit 0

printf '%s\n' '{"decision":"block","reason":"WebFetch is blocked. Use Firecrawl + Browserbase MCP tools instead — far more reliable against sites blocking automated access.\n\nRoute by task:\n- READ (one page, search, crawl, schema extraction) → Firecrawl: firecrawl_{scrape,search,map,crawl,check_crawl_status,extract,search_feedback}. Use firecrawl_scrape with JSON+schema for specific fields, markdown for whole pages. When scrape returns thin content, try firecrawl_map with a search term to find the real URL — cheaper than reaching for an agent.\n- INTERACT (login, multi-step click/fill, persistent page state) → Browserbase: browserbase_{start,navigate,observe,act,extract,end}. For just a couple of clicks after a read, Firecrawl scrape → interact → interact_stop works too.\n- firecrawl_browser_{create,delete,list} are deprecated — use scrape + interact.\n\nFallback chain when both fail: Playwright via /playwright-cli skill (ALWAYS use --headed) → Claude in Chrome. If Chrome is not accessible, ask the user to open it and retry.\n\nEscape hatch: if you are genuinely restricted to the fetch tool with no MCP alternative, add [force-fetch] to the prompt to bypass this block. Use it only as a last resort, not to avoid the routing above. GitHub URLs and llms.txt/llms-full.txt are already allowed through without it.\n\nDo NOT silently accept failed fetch/scrape operations (401, 403, 429, anti-bot walls, CAPTCHA, paywalls, etc.). Surface the failure with the specific error — do not pivot to weaker sources or fabricate around the gap."}'
