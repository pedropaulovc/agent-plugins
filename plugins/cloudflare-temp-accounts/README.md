# cloudflare-temp-accounts plugin

![Cloudflare Temp Accounts plugin icon](./icon.svg)

Provides a skill for provisioning a Cloudflare account through Wrangler's temporary-account flow, claiming it in the intended headed browser session, applying an environment-specific account name, and scoping Wrangler authorization to a project. The workflow uses the pinned Wrangler version `4.128.0`, a disposable Worker project, and a named local OAuth profile.

If Wrangler asks for Cloudflare Terms of Service or Privacy Policy acceptance, the agent must stop for explicit user authorization. The user reviews and authorizes the OAuth consent for only the target account. The skill directs the agent to verify the signed-in email, target account, account ID, and final name. A temporary claim URL is a bearer credential: keep it private and out of shared logs or source.

## Operations and data

For a requested setup, `npx --yes wrangler@4.128.0` can obtain Wrangler through the configured npm registry. Wrangler sends the disposable Worker project to Cloudflare for deployment and communicates with Cloudflare for account claiming and OAuth authorization. The headed browser opens Cloudflare's claim, dashboard, and consent pages; Wrangler stores profile credentials locally and uses them for later account-scoped commands. The workflow also requests the deployed `workers.dev` URL to verify the expected response. The plugin itself supplies instructions and an OpenCode command adapter; these external actions are carried out by the agent at the user's request.

## Documentation and support

- [Documentation](https://go.vza.net/agent-plugins/cloudflare-temp-accounts/docs)
- [Support](https://go.vza.net/agent-plugins/cloudflare-temp-accounts/support)
- [Privacy policy](https://go.vza.net/agent-plugins/cloudflare-temp-accounts/privacy)
