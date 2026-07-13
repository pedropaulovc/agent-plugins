import path from "node:path";
import { fileURLToPath } from "node:url";

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills");

export const WorktreeResetPlugin = async () => ({
  config: async (config) => {
    config.skills ??= {};
    config.skills.paths ??= [];
    if (!config.skills.paths.includes(skillsDir)) config.skills.paths.push(skillsDir);
    config.command ??= {};
    config.command.m ??= {
      description: "Reset the current worktree to origin/main",
      template: "Load the `m` skill and follow it exactly. Arguments: $ARGUMENTS",
    };
  },
});
