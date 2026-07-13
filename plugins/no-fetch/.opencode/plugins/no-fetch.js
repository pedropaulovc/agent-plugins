const denyReason = `WebFetch is blocked. Use Firecrawl + Browserbase MCP tools instead - they are more reliable against sites blocking automated access.

Route by task:
- READ (one page, search, crawl, schema extraction) -> Firecrawl: firecrawl_{scrape,search,map,crawl,check_crawl_status,extract,search_feedback}.
- INTERACT (login, multi-step click/fill, persistent page state) -> Browserbase: browserbase_{start,navigate,observe,act,extract,end}.

Fallback chain when both fail: Playwright via the playwright-cli skill (always use --headed) -> browser integration. Surface specific fetch failures instead of silently changing sources.

Escape hatch: if no MCP alternative is available, add [force-fetch] to the URL. The marker is stripped before the request runs.`;

const excluded = (url) => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const allowedHost = [
      "github.com",
      "githubusercontent.com",
      "github.io",
      "anthropic.com",
      "claude.com",
      "claude.ai",
    ].some((domain) => host === domain || host.endsWith(`.${domain}`));
    return allowedHost || /\/llms(?:-full)?\.txt(?:$|[?#])/.test(parsed.pathname + parsed.search + parsed.hash);
  } catch {
    return false;
  }
};

const stripMarker = (value) => {
  if (typeof value === "string") return value.replace(/ ?\[force-fetch\] ?/g, "");
  if (Array.isArray(value)) return value.map(stripMarker);
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) value[key] = stripMarker(value[key]);
  }
  return value;
};

export const NoFetchPlugin = async () => ({
  "tool.execute.before": async (input, output) => {
    if (input.tool !== "webfetch") return;
    const serialized = JSON.stringify(output.args);
    if (serialized.includes("[force-fetch]")) {
      stripMarker(output.args);
      return;
    }
    if (excluded(output.args.url ?? "")) return;
    throw new Error(denyReason);
  },
});
