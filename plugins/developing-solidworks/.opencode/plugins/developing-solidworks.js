import path from "node:path";
import { fileURLToPath } from "node:url";

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills");

export const DevelopingSolidworksPlugin = async () => ({
  config: async (config) => {
    config.skills ??= {};
    config.skills.paths ??= [];
    if (!config.skills.paths.includes(skillsDir)) config.skills.paths.push(skillsDir);
    config.command ??= {};
    config.command["download-solidworks-docs"] ??= {
      description: "Download and unpack the latest SolidWorks API documentation",
      template: "Load the `download-solidworks-docs` skill and follow it exactly. Arguments: $ARGUMENTS",
    };
  },
});
