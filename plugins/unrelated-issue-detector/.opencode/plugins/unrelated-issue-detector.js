import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const binary = path.join(
  pluginRoot,
  "hooks/bin",
  process.platform === "win32" ? "unrelated-issue-detector.exe" : "unrelated-issue-detector",
);

const toTranscript = (messages) => messages.map(({ info, parts }) => {
  if (info.role === "user") {
    return JSON.stringify({
      type: "user",
      message: { content: parts.filter((part) => part.type === "text").map((part) => part.text).join("\n") },
    });
  }
  return JSON.stringify({
    type: "assistant",
    message: {
      content: parts
        .filter((part) => part.type === "text")
        .map((part) => ({ type: "text", text: part.text })),
    },
  });
}).join("\n");

const inspectTurn = (messages, sessionKey) => {
  if (!["linux", "win32"].includes(process.platform)) return null;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "unrelated-issue-detector-"));
  const transcriptPath = path.join(tempDir, "transcript.jsonl");
  const offsetPath = path.join(os.tmpdir(), `unrelated-issue-${sessionKey}.offset`);
  try {
    writeFileSync(transcriptPath, toTranscript(messages));
    const result = spawnSync(binary, [], {
      input: JSON.stringify({
        session_id: sessionKey,
        transcript_path: transcriptPath,
        stop_hook_active: false,
      }),
      encoding: "utf8",
    });
    if (result.status !== 0 || !result.stdout.trim()) return null;
    return JSON.parse(result.stdout);
  } catch {
    return null;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(offsetPath, { force: true });
  }
};

export const UnrelatedIssueDetectorPlugin = async ({ client, directory }) => {
  const skipNextIdle = new Set();
  const inspectedMessages = new Map();
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;
      const sessionID = event.properties.sessionID;
      const response = await client.session.messages({
        path: { id: sessionID },
        query: { directory },
      });
      const messages = response.data ?? [];
      const lastAssistant = messages.findLast((message) => message.info.role === "assistant");
      const messageID = lastAssistant?.info.id;
      if (!messageID || inspectedMessages.get(sessionID) === messageID) return;
      inspectedMessages.set(sessionID, messageID);
      if (skipNextIdle.delete(sessionID)) return;
      const lastUserIndex = messages.findLastIndex((message) => message.info.role === "user");
      const currentTurn = lastUserIndex < 0 ? messages : messages.slice(lastUserIndex);
      const sessionKey = `${sessionID}-${messageID}`.replace(/[^a-zA-Z0-9._-]/g, "_");
      const decision = inspectTurn(currentTurn, sessionKey);
      if (decision?.decision !== "block" || !decision.reason) return;
      skipNextIdle.add(sessionID);
      await client.session.promptAsync({
        path: { id: sessionID },
        query: { directory },
        body: { parts: [{ type: "text", text: decision.reason, synthetic: true }] },
      });
    },
  };
};
