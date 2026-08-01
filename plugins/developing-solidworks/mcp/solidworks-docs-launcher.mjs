import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = join(pluginRoot, "package.json");
const LOCK_RETRY_MS = 100;
const LOCK_TIMEOUT_MS = 120_000;

function dependenciesAvailable() {
  try {
    const require = createRequire(packageJson);
    require.resolve("zod/v4");
    require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
    require.resolve("@modelcontextprotocol/sdk/server/stdio.js");
    return true;
  } catch {
    return false;
  }
}

async function withInstallLock(callback) {
  const lockPath = join(pluginRoot, ".mcp-install-lock");
  const startedAt = Date.now();
  while (true) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for MCP dependency installation lock: ${lockPath}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_RETRY_MS));
    }
  }
  try {
    return await callback();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

async function installDependencies() {
  if (dependenciesAvailable()) return;
  await withInstallLock(async () => {
    if (dependenciesAvailable()) return;
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = spawnSync(npm, [
      "install",
      "--prefix",
      pluginRoot,
      "--no-save",
      "--no-package-lock",
      "--ignore-scripts",
      "--omit=dev",
      "--fund=false",
      "--audit=false",
      "--loglevel=error",
    ], { stdio: ["ignore", "ignore", "inherit"] });
    if (result.error) throw new Error(`Unable to install SolidWorks MCP dependencies with ${npm}: ${result.error.message}`);
    if (result.status !== 0 || !dependenciesAvailable()) throw new Error(`Unable to install SolidWorks MCP dependencies with ${npm}; exit status ${result.status ?? "unknown"}`);
  });
}

await installDependencies();
const { runMcpServer } = await import(pathToFileURL(join(pluginRoot, "mcp", "solidworks-docs-mcp.mjs")));
await runMcpServer();
