import path from "node:path";
import { fileURLToPath } from "node:url";

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills");

export const PrCommentsPlugin = async () => ({
  config: async (config) => {
    config.skills ??= {};
    config.skills.paths ??= [];
    if (!config.skills.paths.includes(skillsDir)) config.skills.paths.push(skillsDir);
    config.command ??= {};
    config.command.comments ??= {
      description: "Fetch and review active pull request comments",
      template: "Load the `comments` skill and follow it exactly. Arguments: $ARGUMENTS",
    };
  },
});
