import path from "node:path";
import { fileURLToPath } from "node:url";

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills");

export const TestAuditPlugin = async () => ({
  config: async (config) => {
    config.skills ??= {};
    config.skills.paths ??= [];
    if (!config.skills.paths.includes(skillsDir)) config.skills.paths.push(skillsDir);
    config.command ??= {};
    config.command["test-audit"] ??= {
      description: "Draft test-value audit; report-only unless a boundary cutover is explicitly authorized",
      template: "Load the `test-audit` skill and follow it exactly. Default to report-only. Arguments: $ARGUMENTS",
    };
  },
});
