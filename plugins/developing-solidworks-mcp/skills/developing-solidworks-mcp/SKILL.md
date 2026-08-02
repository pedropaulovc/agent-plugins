---
name: developing-solidworks-mcp
description: Query the bundled SolidWorks XMLDoc index through MCP for grounded API types, members, enums, examples, and guides. Use when the SolidWorks documentation MCP server is available and an API lookup is needed.
---

# SolidWorks XMLDoc MCP

Use this plugin's MCP server for grounded SolidWorks API documentation instead of guessing names, signatures, enum values, or parameter metadata. The server downloads and caches the latest `SolidWorks.Interop.xmldoc.zip` release on first use.

Set `SOLIDWORKS_DOCS_BUNDLE` to an absolute local ZIP path for offline or fixture-driven use, or `SOLIDWORKS_DOCS_CACHE_DIR` to control the cache location.

## Tools

- `status` — verify the cached bundle version and report the newest release metadata when the cached bundle came from the release feed. Inspect `latestOnline` and `updateAvailable` before deciding to refresh.
- `refresh` — explicitly replace the cached bundle with the latest release.
- `search` — search indexed assemblies, API types, members, examples, and guides. Filter with `kind` and `assembly`; `kind` defaults to `all` and uses the same assembly, type, enum, member, example, and guide categories as `list`. Results are paginated; follow `nextOffset` while `truncated` is true.
- `list` — return a paginated catalog for assemblies, types, enums, members, examples, and guides. Filter with `kind`, `query`, `assembly`, `type`, `member`, `language`, or `root`.
- `get` — retrieve complete grounded content by `kind`: use `type` or `enum` for API types and their paginated `members`, `example` for a complete code example, and `guide` for a complete Markdown guide. Pass `includeRawXml` only when the XMLDoc representation itself matters.
- `glob` — browse virtual paths such as `types/IModelDoc2/**`, `enums/swEndConditions_e`, `examples/**`, and `guides/**`.

## Lookup workflow

1. Use `search` or `list` to identify the exact API record.
2. Use `get` with `kind: "type"` or `kind: "enum"` for complete signatures and member documentation.
3. Use `get` with `kind: "example"` before adapting an automation pattern.
4. Use `get` with `kind: "guide"` for conceptual workflows.
5. Preserve XMLDoc IDs, overload parameter syntax, by-reference markers, enum values, and example links in the resulting code.

Use this plugin instead of `developing-solidworks` for structured documentation lookup; do not install both.
