# developing-solidworks-mcp

![Developing SolidWorks MCP plugin icon](./icon.svg)

A standalone MCP server for grounded SolidWorks XMLDoc API documentation.

## What it does

- Without `SOLIDWORKS_DOCS_BUNDLE`, the first tool call checks GitHub's latest release and downloads its XMLDoc ZIP if the cached release is not current
- Searches indexed assemblies, types, enums, members, examples, and guides
- Lists the documentation catalog with pagination and filters
- Retrieves complete type, enum, example, and guide records through `get(kind)`
- Matches virtual documentation paths and returns entry metadata through `glob`; use `get` to retrieve complete type, enum, example, or guide content
- Reports cached bundle details through `status`; release-backed caches also include latest online release metadata, while local-bundle mode does not query it

New release ZIPs are checked and extracted into a local cache. Set `SOLIDWORKS_DOCS_BUNDLE` to an absolute ZIP path to avoid GitHub release requests, or set `SOLIDWORKS_DOCS_CACHE_DIR` to control the cache location. Fully offline startup also requires the Node dependencies to be installed already.

## Relationship to developing-solidworks

Use this plugin instead of [developing-solidworks](../developing-solidworks) for structured documentation lookup; do not install both. This plugin provides the MCP documentation service.

## MCP tools

- `status` — inspect cache details; for a release-backed cache it also checks the latest online release metadata
- `refresh` — force a release check and bundle replacement; with a local bundle configured, reloads that ZIP instead
- `search` — search indexed documentation with list-compatible `kind` and assembly filters
- `list` — browse a paginated catalog of assemblies, types, enums, members, examples, and guides
- `get` — retrieve a complete record by `kind` (`type`, `enum`, `example`, or `guide`)
- `glob` — match virtual documentation paths and return entry metadata, not document contents

The server uses stdio. Claude Code registers it through `.mcp.json`; OpenCode registers it through the plugin hook.

## Data handling

The MCP server runs locally over stdio and indexes the XMLDoc bundle from a local cache. When using the release-backed cache, it requests release metadata from GitHub's `pedropaulovc/offline-solidworks-api-docs` Releases API and downloads the selected XMLDoc ZIP when the cache is missing, stale, or explicitly refreshed. It does not send search terms or tool arguments to GitHub. Set `SOLIDWORKS_DOCS_BUNDLE` to use a local ZIP without release downloads.

If its Node dependencies are absent, the launcher runs `npm install` for the declared MCP SDK and Zod dependencies through the configured npm registry. MCP tool requests and results pass through the configured host and are subject to that host's data handling. In local-bundle mode, `status` also returns the resolved source path to the host. Set `SOLIDWORKS_DOCS_CACHE_DIR` to control the local cache.

## Documentation and support

- [Documentation](https://go.vza.net/agent-plugins/developing-solidworks-mcp/docs)
- [Support](https://go.vza.net/agent-plugins/developing-solidworks-mcp/support)
- [Privacy policy](https://go.vza.net/agent-plugins/developing-solidworks-mcp/privacy)
