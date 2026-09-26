# Privacy — developing-solidworks-mcp

## What this plugin does

The MCP server runs locally over stdio and searches a downloaded SolidWorks XMLDoc bundle. Tool arguments are processed against the local index and results are returned to the configured MCP host. The plugin does not send search strings, API names, filters, or other tool arguments to GitHub.

## Downloads and external destinations

When Node dependencies are missing, the launcher runs `npm install` for the declared `@modelcontextprotocol/sdk` and `zod` dependencies and their dependency tree through the npm registry configured on the machine. The install uses `--ignore-scripts`; npm receives its ordinary package-install request metadata.

For a release-backed bundle, the server requests release metadata from `https://api.github.com/repos/pedropaulovc/offline-solidworks-api-docs/releases/latest`. It downloads the selected XMLDoc ZIP from the release asset URL when no usable cached bundle exists or when `refresh` is requested. `status` checks online release metadata for a release-backed cache. GitHub receives ordinary request metadata, but tool arguments are not included in those requests. Set `SOLIDWORKS_DOCS_BUNDLE` to index a local ZIP without contacting the release feed or downloading an asset.

## Local storage and host processing

The extracted documentation and bundle metadata are stored in a local cache. Set `SOLIDWORKS_DOCS_CACHE_DIR` to choose its location; otherwise the server uses `CLAUDE_PLUGIN_DATA/solidworks-docs`, `XDG_CACHE_HOME/developing-solidworks`, Windows `LOCALAPPDATA/developing-solidworks`, or `~/.cache/developing-solidworks`. Search arguments and indexed documentation are not persisted as query history. In local-bundle mode, the cached metadata and `status` response contain the resolved source ZIP path, which is returned to the MCP host. In Claude Code, the prompt, MCP tool inputs, and returned documentation also pass through the normal Claude conversation, processed by Anthropic under the privacy and data controls applicable to the account; that host processing is separate from the plugin's GitHub and npm requests. Other hosts and providers have their own data practices.

The server has no publisher-operated API or telemetry endpoint. The npm registry and GitHub are the external services used by its dependency bootstrap and release-backed documentation flow.