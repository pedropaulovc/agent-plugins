import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const mcpUrl = "https://watch-pr.vza.net/mcp";

export const WatchPrPlugin = async () => ({
  config: async (config) => {
    const skillsDir = path.join(pluginRoot, "skills");
    config.skills ??= {};
    config.skills.paths ??= [];
    if (!config.skills.paths.includes(skillsDir)) config.skills.paths.push(skillsDir);

    config.command ??= {};
    config.command["watch-pr"] ??= {
      description: "Watch a pull request through CI, review, and merge",
      template: "Load the `watch-pr` skill and follow it exactly. Arguments: $ARGUMENTS",
    };

    config.mcp ??= {};
    config.mcp["watch-pr"] ??= {
      type: "remote",
      url: mcpUrl,
    };
  },
});
