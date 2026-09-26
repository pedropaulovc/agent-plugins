# Privacy — cloudflare-temp-accounts

## What this plugin does

This plugin provides agent instructions and an OpenCode command adapter for Wrangler's temporary-account workflow. The adapter registers the skill; the agent runs the shell commands and browser steps only as part of a requested account-provisioning task.

## Information and services involved

The workflow may use project files and configuration, an account name, account identifiers, the intended account email, and Wrangler authentication. `npx --yes wrangler@4.128.0` may retrieve the pinned Wrangler package from the npm registry configured on your machine. Wrangler sends the disposable Worker project to Cloudflare for temporary deployment and communicates with Cloudflare to claim the account, authorize OAuth access, and perform account-scoped operations. A headed browser opens Cloudflare's claim, dashboard, and OAuth consent pages.

Cloudflare receives deployment contents and account actions needed for the requested workflow. The skill also directs the agent to request the deployed Worker URL under `workers.dev` to verify its response. Wrangler stores local profile credentials and account/project bindings on the machine; the instructions use a fresh `HOME` and `XDG_CONFIG_HOME` for the temporary-account deployment and bind named profiles to project directories. A claim URL is a bearer credential and can grant access to the temporary account: do not share it or put it in logs, source, or a final response.

## Consent and control

When used in Claude Code, prompts and account/project context supplied to the assistant, and tool output returned to it, are part of the normal Claude conversation processed by Anthropic under the privacy and data controls applicable to the user's account. That host processing is separate from Wrangler's npm and Cloudflare requests described above. OAuth consent is completed in the headed browser for the target account only. The skill does not operate a publisher-hosted account service or telemetry endpoint; Wrangler, npm, Cloudflare, and other agent hosts apply their own service and data policies to the requests they handle.