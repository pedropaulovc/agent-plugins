# developing-solidworks-mcp

A standalone MCP server for grounded SolidWorks XMLDoc API documentation.

## What it does

- Downloads and caches the latest `SolidWorks.Interop.xmldoc.zip` release on first use
- Searches indexed assemblies, types, enums, members, examples, and guides
- Lists the documentation catalog with pagination and filters
- Retrieves complete type, enum, example, and guide records through `get(kind)`
- Browses stable virtual documentation paths with `glob`
- Reports cached and latest online release metadata through `status`

The server is release-aware and keeps a validated local cache. Set `SOLIDWORKS_DOCS_BUNDLE` to an absolute local ZIP path for offline or fixture-driven use, or `SOLIDWORKS_DOCS_CACHE_DIR` to control the cache location.

## Relationship to developing-solidworks

Install [developing-solidworks](../developing-solidworks) separately when you also need the C#/COM coding skill, bundled filesystem API reference, learnings, and `/download-solidworks-docs` command. This plugin only provides the structured MCP documentation service.

## MCP tools

- `status` — inspect the cached bundle and latest release metadata
- `refresh` — replace the cached bundle with the latest release
- `search` — search indexed documentation with list-compatible `kind` and assembly filters
- `list` — browse a paginated catalog of assemblies, types, members, examples, and guides
- `get` — retrieve a complete record by `kind` (`type`, `enum`, `example`, or `guide`)
- `glob` — match virtual documentation paths

The server runs over stdio and is registered through `.mcp.json` for supported hosts.
