import path from "node:path";
import { fileURLToPath } from "node:url";

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills");

export const AltTextPlugin = async () => ({
  config: async (config) => {
    config.skills ??= {};
    config.skills.paths ??= [];
    if (!config.skills.paths.includes(skillsDir)) config.skills.paths.push(skillsDir);
    config.command ??= {};
    config.command["alt-text"] ??= {
      description: "Write accessibility-focused alt text for an image",
      template: "Load the `alt-text` skill and follow it exactly. Arguments: $ARGUMENTS",
    };
  },
});
