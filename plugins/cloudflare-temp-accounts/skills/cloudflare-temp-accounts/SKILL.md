---
name: cloudflare-temp-accounts
description: Provision Cloudflare accounts with Wrangler temporary deployments, claim them immediately in a headed browser, rename them using the requested environment convention, and isolate Wrangler OAuth profiles. Use when the user asks to create, claim, rename, or configure a new Cloudflare account through Wrangler's temporary-account flow. Always use a headed browser for Cloudflare claim and OAuth consent; never silently substitute a headless session.
---

# Cloudflare temporary accounts

Create a permanent Cloudflare account from Wrangler's temporary-account flow, claim it before the claim window expires, and leave local Wrangler credentials scoped to that account.

## Naming contract

Choose the final account and profile name before provisioning. Do not keep Wrangler's generated temporary name.

For the VZA environment convention:

- Production: `<project>-vza-net-prod`
- PPE: `<project>-ppe-vza-net`

Keep the `-ppe-` segment and the production `-prod` suffix exactly. If the user supplies a different environment convention, use that explicit convention instead of guessing.

## Provision in isolation

1. Pin Wrangler to the reviewed version `4.128.0`; use `npx --yes wrangler@4.128.0` for every command below. Do not use a mutable package tag in an account-provisioning run.
2. Create a minimal Worker project in a disposable, account-specific directory. Set a fresh `HOME` and `XDG_CONFIG_HOME` for each account so an existing OAuth token or temporary-account cache cannot be reused accidentally.
3. Run the deployment from a headed terminal:

   ```bash
   env \
     -u CLOUDFLARE_API_TOKEN \
     -u CLOUDFLARE_API_KEY \
     -u CLOUDFLARE_EMAIL \
     CLOUDFLARE_AUTH_USE_KEYRING=false \
     HOME=/tmp/<account>-home \
     XDG_CONFIG_HOME=/tmp/<account>-home/config \
     npx --yes wrangler@4.128.0 deploy --temporary --config /tmp/<account>/wrangler.toml
   ```
   The `env -u` options clear inherited Cloudflare credentials; keep this sanitized prefix for every temporary-account Wrangler invocation.

4. If Wrangler asks for Cloudflare Terms of Service or Privacy Policy acceptance, stop and obtain explicit user authorization before accepting.
5. Keep the temporary account ID and claim URL private. A claim URL is a bearer credential: never paste it into source, shared logs, telemetry, or the final response.

## Claim with a headed browser

1. Use the persistent headed browser session already authenticated as the intended Cloudflare email. Match the session to the account owner named by the user; do not switch accounts during the flow.
2. Open the Wrangler claim URL in that headed session. Verify the signed-in email and Worker name on the claim page before acting.
3. Click `Claim`, then wait for the dashboard to finish provisioning. Do not treat an intermediate setup page as success.
4. Reload the dashboard account list and confirm that the claimed account is present. Generated temporary account names are expected before the rename step.
5. From the account-list `Actions` menu, choose `Change account name`, enter the final name, save, reload, and verify the exact spelling. An existing workers.dev hostname may retain its generated subdomain after the account rename.

Headed browser use is mandatory for claim and OAuth consent. Do not replace it with a headless browser or an unauthenticated API shortcut.

## Create an isolated Wrangler profile

Create one named OAuth profile per account. Clear inherited Cloudflare credentials before profile creation, activation, and all profile-scoped commands.

1. Start the profile flow and keep its local callback process running:

   ```bash
   env \
     -u CLOUDFLARE_API_TOKEN \
     -u CLOUDFLARE_API_KEY \
     -u CLOUDFLARE_EMAIL \
     CLOUDFLARE_AUTH_USE_KEYRING=false \
     npx --yes wrangler@4.128.0 auth create <final-account-name> --browser=false
   ```

2. Open the emitted OAuth URL in the matching headed browser session.
3. On the consent screen, select only the target account. Never choose `Grant access to all accounts` for an account-specific profile. Review and authorize, then wait for the local Wrangler process to exit successfully.
4. Bind the profile to its own project directory:

   ```bash
   env \
     -u CLOUDFLARE_API_TOKEN \
     -u CLOUDFLARE_API_KEY \
     -u CLOUDFLARE_EMAIL \
     CLOUDFLARE_AUTH_USE_KEYRING=false \
     npx --yes wrangler@4.128.0 auth activate <final-account-name> <project-directory>
   ```

5. Pin the matching `account_id` in that project's Wrangler config. The profile scope and config account ID provide independent protection against deploying to the wrong account.

## Verify end to end

Run checks from each account-specific project directory. Keep the sanitized `env -u` prefix for every Wrangler command:

```bash
env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY -u CLOUDFLARE_EMAIL \
  CLOUDFLARE_AUTH_USE_KEYRING=false npx --yes wrangler@4.128.0 auth list
env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY -u CLOUDFLARE_EMAIL \
  CLOUDFLARE_AUTH_USE_KEYRING=false npx --yes wrangler@4.128.0 whoami --json --cwd <project-directory>
```

- `auth list` shows the named profile and its directory binding.
- `whoami --json --cwd <project-directory>` reports the intended email, exact account ID, and exact final account name.
- Curl the deployed workers.dev URL and verify the expected Worker response.
- Confirm the account list in the headed dashboard also shows the final name under the intended email.

Leave only non-secret metadata such as the final account name, account ID, profile name, directory binding, and Worker URL. Remove temporary claim URLs and credentials from shared files and logs.
