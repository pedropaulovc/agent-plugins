import path from "node:path";
import { fileURLToPath } from "node:url";

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills");
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const launcherPath = path.join(pluginRoot, "mcp", "solidworks-docs-launcher.mjs");

export const DevelopingSolidworksMcpPlugin = async () => ({
  config: async (config) => {
    config.skills ??= {};
    config.skills.paths ??= [];
    if (!config.skills.paths.includes(skillsDir)) config.skills.paths.push(skillsDir);
    config.mcp ??= {};
    config.mcp["solidworks-docs"] ??= {
      type: "local",
      command: ["node", launcherPath],
      enabled: true,
    };
  },
});
