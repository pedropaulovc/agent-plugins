import path from "node:path";
import { fileURLToPath } from "node:url";

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills");

export const CloudflareTempAccountsPlugin = async () => ({
  config: async (config) => {
    config.skills ??= {};
    config.skills.paths ??= [];
    if (!config.skills.paths.includes(skillsDir)) config.skills.paths.push(skillsDir);
    config.command ??= {};
    config.command["cloudflare-temp-accounts"] ??= {
      description: "Provision and isolate a Cloudflare temporary account",
      template: "Load the `cloudflare-temp-accounts` skill and follow it exactly. Arguments: $ARGUMENTS",
    };
  },
});
