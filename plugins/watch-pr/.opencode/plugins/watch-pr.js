import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const projectConfigPackage = path.resolve(pluginRoot, "../../.opencode/package.json");
const require = createRequire(existsSync(projectConfigPackage) ? projectConfigPackage : import.meta.url);
const { z } = require("zod");
const defaultWatchScript = path.join(pluginRoot, "skills/watch-pr/watch-pr.sh");
const BATCH_DELAY_MS = 200;
const execFileAsync = promisify(execFile);

export const WatchPrPlugin = async ({ client, directory }, options = {}) => {
  const watchers = new Map();
  const notificationQueues = new Map();
  const watchScript = typeof options.watchScript === "string"
    ? path.resolve(options.watchScript)
    : defaultWatchScript;
  const ghBinary = typeof options.ghBinary === "string" ? options.ghBinary : "gh";

  const resolveRef = async (cwd, ref) => {
    if (ref?.trim()) return ref.trim();
    try {
      const { stdout } = await execFileAsync(
        ghBinary,
        ["pr", "view", "--json", "url", "--jq", ".url"],
        { cwd, encoding: "utf8" },
      );
      const url = stdout.trim();
      if (url) return url;
    } catch {
      // Replace CLI details with a stable tool-facing error below.
    }
    throw new Error("watch-pr could not resolve a pull request for the current branch; pass a PR number, URL, or branch explicitly.");
  };

  const notify = (sessionID, sessionDirectory, lines) => {
    const text = [
      "[watch-pr monitor event]",
      ...lines,
      "",
      "Follow the loaded watch-pr skill's event table. Act on these changes now; do not start another watcher.",
    ].join("\n");
    const previous = notificationQueues.get(sessionID) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => client.session.promptAsync({
        path: { id: sessionID },
        query: { directory: sessionDirectory },
        body: { parts: [{ type: "text", text, synthetic: true }] },
      }))
      .catch(async (error) => {
        try {
          await client.app?.log?.({
            body: {
              service: "watch-pr",
              level: "error",
              message: "Failed to deliver monitor event",
              extra: { sessionID, error: String(error) },
            },
          });
        } catch {
          // Notification delivery failures must not crash the plugin host.
        }
      });
    notificationQueues.set(sessionID, next);
    void next.finally(() => {
      if (notificationQueues.get(sessionID) === next) notificationQueues.delete(sessionID);
    });
  };

  const stopWatcher = (sessionID) => {
    const watcher = watchers.get(sessionID);
    if (!watcher) return false;
    watcher.stopping = true;
    watcher.lines.length = 0;
    watcher.remainder = "";
    if (watcher.timer) clearTimeout(watcher.timer);
    watcher.child.kill();
    watchers.delete(sessionID);
    return true;
  };

  const startWatcher = (sessionID, cwd, ref, stallTimeout) => {
    stopWatcher(sessionID);
    const args = [watchScript, ref];
    if (stallTimeout) args.push("--stall-timeout", stallTimeout);
    const child = spawn("bash", args, {
      cwd,
      env: { ...process.env, OPENCODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const watcher = {
      child,
      ref: ref || "current branch",
      stallTimeout: stallTimeout || "1h",
      lines: [],
      remainder: "",
      timer: null,
      stopping: false,
      failed: false,
    };
    watchers.set(sessionID, watcher);

    const flush = () => {
      if (watcher.timer) clearTimeout(watcher.timer);
      watcher.timer = null;
      if (!watcher.lines.length) return;
      const lines = watcher.lines.splice(0);
      notify(sessionID, cwd, lines);
    };

    const enqueue = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      watcher.lines.push(trimmed);
      if (!watcher.timer) watcher.timer = setTimeout(flush, BATCH_DELAY_MS);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const pieces = (watcher.remainder + chunk).split(/\r?\n/);
      watcher.remainder = pieces.pop() ?? "";
      for (const line of pieces) enqueue(line);
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });

    child.on("error", (error) => {
      watcher.failed = true;
      enqueue(`error watcher failed to start: ${error.message}`);
      flush();
      if (watchers.get(sessionID)?.child === child) watchers.delete(sessionID);
    });

    child.on("close", (code, signal) => {
      if (watcher.stopping || watcher.failed) return;
      if (watcher.remainder) enqueue(watcher.remainder);
      if (code && code !== 0) {
        enqueue(`error watcher exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
      } else if (signal && signal !== "SIGTERM") {
        enqueue(`error watcher stopped by ${signal}`);
      }
      flush();
      if (watchers.get(sessionID)?.child === child) watchers.delete(sessionID);
    });

    return watcher;
  };

  return {
    config: async (config) => {
      const skillsDir = path.join(pluginRoot, "skills");
      config.skills ??= {};
      config.skills.paths ??= [];
      if (!config.skills.paths.includes(skillsDir)) config.skills.paths.push(skillsDir);
      config.command ??= {};
      config.command["watch-pr"] ??= {
        description: "Watch a pull request through CI, review, and merge",
        template: "Load the `watch-pr` skill and follow it exactly. Arguments: $ARGUMENTS",
      };
    },

    tool: {
      watch_pr: {
        description: "Start, stop, or inspect an event-driven pull request monitor. The monitor wakes this OpenCode session when the PR changes.",
        args: {
          action: z.enum(["start", "stop", "status"]).default("start"),
          ref: z.string().optional().describe("PR number, URL, or branch accepted by gh pr view"),
          stallTimeout: z.string().regex(/^[1-9][0-9]*[smhd]$/).optional().describe("Quiet interval before a stall notification, such as 30m or 2h (default: 1h)"),
        },
        async execute({ action, ref, stallTimeout }, context) {
          const sessionID = context.sessionID;
          if (action === "stop") {
            return stopWatcher(sessionID) ? "Stopped the watch-pr monitor." : "No watch-pr monitor is active.";
          }
          if (action === "status") {
            const active = watchers.get(sessionID);
            return active
              ? `watch-pr is monitoring ${active.ref} with a ${active.stallTimeout} stall timeout (pid ${active.child.pid}).`
              : "No watch-pr monitor is active.";
          }
          const cwd = context.directory || directory;
          const resolvedRef = await resolveRef(cwd, ref);
          const active = startWatcher(sessionID, cwd, resolvedRef, stallTimeout);
          return `Started event-driven watch-pr monitoring for ${active.ref} with a ${active.stallTimeout} stall timeout (pid ${active.child.pid}). This session will be notified automatically; do not poll it.`;
        },
      },
    },

    event: async ({ event }) => {
      if (event.type === "session.deleted") stopWatcher(event.properties.info.id);
    },

    dispose: async () => {
      for (const sessionID of [...watchers.keys()]) stopWatcher(sessionID);
      await Promise.allSettled(notificationQueues.values());
    },
  };
};
