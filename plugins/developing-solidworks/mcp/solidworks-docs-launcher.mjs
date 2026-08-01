import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = join(pluginRoot, "package.json");
const LOCK_RETRY_MS = 100;
const LOCK_TIMEOUT_MS = 120_000;
const LOCK_STALE_MS = LOCK_TIMEOUT_MS;
const INSTALL_TIMEOUT_MS = 100_000;
const LOCK_METADATA_NAME = "owner.json";

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

async function readInstallLockMetadata(lockPath) {
  try {
    return JSON.parse(await fs.readFile(join(lockPath, LOCK_METADATA_NAME), "utf8"));
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function reclaimStaleInstallLock(lockPath) {
  let lockStats;
  try {
    lockStats = await fs.stat(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  const metadata = await readInstallLockMetadata(lockPath);
  const createdAt = typeof metadata?.createdAt === "number" ? metadata.createdAt : NaN;
  const age = Number.isFinite(createdAt) ? Date.now() - createdAt : Date.now() - lockStats.mtimeMs;
  const pid = Number(metadata?.pid);
  if (Number.isInteger(pid) && pid > 0) {
    if (processIsAlive(pid)) return false;
  } else if (age <= LOCK_STALE_MS) {
    return false;
  }
  const stalePath = `${lockPath}.stale-${randomUUID()}`;
  try {
    await fs.rename(lockPath, stalePath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  const movedMetadata = await readInstallLockMetadata(stalePath);
  if (movedMetadata?.token !== metadata?.token) {
    try {
      await fs.rename(stalePath, lockPath);
    } catch {
      // Another process acquired the lock while it was being inspected.
    }
    return false;
  }
  await fs.rm(stalePath, { recursive: true, force: true });
  return true;
}

async function withInstallLock(callback) {
  const lockPath = join(pluginRoot, ".mcp-install-lock");
  const token = randomUUID();
  const startedAt = Date.now();
  while (true) {
    let created = false;
    try {
      await fs.mkdir(lockPath);
      created = true;
      await fs.writeFile(join(lockPath, LOCK_METADATA_NAME), JSON.stringify({ pid: process.pid, createdAt: Date.now(), token }), { flag: "wx" });
      break;
    } catch (error) {
      if (created) await fs.rm(lockPath, { recursive: true, force: true });
      if (error.code !== "EEXIST") throw error;
      if (await reclaimStaleInstallLock(lockPath)) continue;
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for MCP dependency installation lock: ${lockPath}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_RETRY_MS));
    }
  }
  try {
    return await callback();
  } finally {
    const metadata = await readInstallLockMetadata(lockPath);
    if (metadata?.token === token) await fs.rm(lockPath, { recursive: true, force: true });
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
    ], { stdio: ["ignore", "ignore", "inherit"], timeout: INSTALL_TIMEOUT_MS });
    if (result.error?.code === "ETIMEDOUT") throw new Error(`Timed out installing SolidWorks MCP dependencies with ${npm} after ${INSTALL_TIMEOUT_MS} ms; check network access and retry`);
    if (result.error) throw new Error(`Unable to install SolidWorks MCP dependencies with ${npm}: ${result.error.message}`);
    if (result.status !== 0 || !dependenciesAvailable()) throw new Error(`Unable to install SolidWorks MCP dependencies with ${npm}; exit status ${result.status ?? "unknown"}`);
  });
}

await installDependencies();
const { runMcpServer } = await import(pathToFileURL(join(pluginRoot, "mcp", "solidworks-docs-mcp.mjs")));
await runMcpServer();
