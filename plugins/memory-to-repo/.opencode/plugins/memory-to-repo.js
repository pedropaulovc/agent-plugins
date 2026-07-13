import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const skillsDir = path.join(pluginRoot, "skills");
const binary = path.join(
  pluginRoot,
  "hooks/bin",
  process.platform === "win32" ? "memory-to-repo.exe" : "memory-to-repo",
);

const runHook = (event, input, directory) => {
  if (!(["linux", "win32"].includes(process.platform))) return null;
  const env = { ...process.env, CLAUDE_PROJECT_DIR: directory };
  delete env.PLUGIN_ROOT;
  const result = spawnSync(binary, [event], {
    cwd: directory,
    env,
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
};

const normalizeToolInput = (args) => ({
  ...args,
  file_path: args.file_path ?? args.filePath ?? "",
  command: args.command ?? args.patchText ?? args.patch ?? "",
});

const stripMarker = (value) => {
  if (typeof value === "string") return value.replace(/ ?\[force-memory\] ?/g, "");
  if (Array.isArray(value)) return value.map(stripMarker);
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) value[key] = stripMarker(value[key]);
  }
  return value;
};

export const MemoryToRepoPlugin = async ({ directory }) => {
  const sessionOutput = runHook("session-start", {}, directory);
  const sessionContext = sessionOutput?.hookSpecificOutput?.additionalContext;

  return {
    config: async (config) => {
      config.skills ??= {};
      config.skills.paths ??= [];
      if (!config.skills.paths.includes(skillsDir)) config.skills.paths.push(skillsDir);
      config.command ??= {};
      config.command["memory-audit"] ??= {
        description: "Audit repository memory for stale facts",
        template: "Load the `memory-audit` skill and follow it exactly. Arguments: $ARGUMENTS",
      };
      config.command["record-memory-usage"] ??= {
        description: "Refresh repository memory usage rankings",
        template: "Load the `record-memory-usage` skill and follow it exactly.",
      };
    },

    "experimental.chat.system.transform": async (_input, output) => {
      if (sessionContext && !output.system.includes(sessionContext)) output.system.push(sessionContext);
    },

    "tool.execute.before": async (input, output) => {
      const hookOutput = runHook(
        "pre-tool-use",
        { tool_name: input.tool, tool_input: normalizeToolInput(output.args) },
        directory,
      )?.hookSpecificOutput;
      if (!hookOutput) return;
      if (hookOutput.permissionDecision === "deny") {
        throw new Error(hookOutput.permissionDecisionReason);
      }
      if (hookOutput.updatedInput) stripMarker(output.args);
    },
  };
};
