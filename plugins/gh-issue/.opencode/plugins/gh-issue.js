import path from "node:path";
import { fileURLToPath } from "node:url";

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills");

export const GhIssuePlugin = async () => ({
  config: async (config) => {
    config.skills ??= {};
    config.skills.paths ??= [];
    if (!config.skills.paths.includes(skillsDir)) config.skills.paths.push(skillsDir);
    config.command ??= {};
    config.command.issue ??= {
      description: "Turn a terse request into a structured GitHub issue",
      template: "Load the `issue` skill and follow it exactly. Arguments: $ARGUMENTS",
    };
  },
});
