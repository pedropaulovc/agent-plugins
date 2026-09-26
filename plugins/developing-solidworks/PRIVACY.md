# Privacy — developing-solidworks

## What this plugin does

This plugin supplies instructions, reference material helpers, and a command for agents working with SolidWorks automation. The host may include prompts, local source code, documentation, and tool results in its conversation. The agent may inspect or run local project code and SolidWorks automation when asked; the resulting file or application changes depend on the commands used.

## Downloads and external destinations

The bundled documentation downloader makes a request to the GitHub Releases API for `pedropaulovc/offline-solidworks-api-docs`, selects the latest `*llms.v*.zip` release asset, downloads it from the asset's GitHub-provided URL, and extracts it into the local skill directory. The skill may also direct the agent to make a release-metadata request to the same GitHub API to check whether a newer bundle exists. These requests retrieve reference documentation; the downloader does not include the user's source project in them. GitHub receives ordinary request metadata such as the network address and request headers.

The downloaded archive is written temporarily on the local machine, extracted as documentation under the selected skill directory, and then the temporary archive is removed. The `find_api_redist.py` helper searches local installation paths for SolidWorks Interop assemblies; it does not upload those files.

## Other processing

There is no plugin-operated service or telemetry endpoint. When used in Claude Code, prompts, source code, and tool results included in the conversation are processed by Anthropic under the privacy and data controls applicable to the account; this is separate from the release requests to GitHub. Other agent hosts and model providers have their own data practices. Commands or integrations used by the agent may contact their own services; those actions are separate from the bundled documentation downloader.