import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const binary = path.join(
  pluginRoot,
  "hooks/bin",
  process.platform === "win32" ? "playwright-cli-headed.exe" : "playwright-cli-headed",
);

export const PlaywrightCliHeadedPlugin = async () => {
  const notices = new Map();
  return {
    "tool.execute.before": async (input, output) => {
      if (!(["bash", "powershell"].includes(input.tool)) || !["linux", "win32"].includes(process.platform)) return;
      const env = { ...process.env };
      delete env.PLUGIN_ROOT;
      const toolName = input.tool === "powershell" ? "PowerShell" : "Bash";
      const result = spawnSync(binary, [], {
        env,
        input: JSON.stringify({ tool_name: toolName, tool_input: output.args }),
        encoding: "utf8",
      });
      if (result.status !== 0 || !result.stdout.trim()) return;
      try {
        const hook = JSON.parse(result.stdout).hookSpecificOutput;
        if (hook?.updatedInput) output.args = hook.updatedInput;
        if (hook?.additionalContext) notices.set(input.callID, hook.additionalContext);
      } catch {
        // Malformed hook output must not prevent the original tool call.
      }
    },
    "tool.execute.after": async (input, output) => {
      const notice = notices.get(input.callID);
      if (!notice) return;
      notices.delete(input.callID);
      output.output += `\n\n[playwright-cli-headed] ${notice}`;
    },
  };
};
