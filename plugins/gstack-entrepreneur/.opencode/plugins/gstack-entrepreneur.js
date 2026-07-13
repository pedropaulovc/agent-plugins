import path from "node:path";
import { fileURLToPath } from "node:url";

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills");

export const GstackEntrepreneurPlugin = async () => ({
  config: async (config) => {
    config.skills ??= {};
    config.skills.paths ??= [];
    if (!config.skills.paths.includes(skillsDir)) config.skills.paths.push(skillsDir);
    config.command ??= {};
    const commands = {
      autoplan: "Create a structured decision plan",
      "ceo-review": "Review strategy from a CEO perspective",
      codex: "Get an independent cross-model second opinion",
      "market-research": "Research a market and its competitors",
      "office-hours": "Work through an idea as a YC office-hours session",
    };
    for (const [name, description] of Object.entries(commands)) {
      config.command[name] ??= {
        description,
        template: `Load the \`${name}\` skill and follow it exactly. Arguments: $ARGUMENTS`,
      };
    }
  },
});
