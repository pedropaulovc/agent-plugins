import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const binary = path.join(
  pluginRoot,
  "hooks/bin",
  process.platform === "win32" ? "mediocrity-detector.exe" : "mediocrity-detector",
);

const toTranscript = (messages) => messages.map(({ info, parts }) => {
  if (info.role === "user") {
    return JSON.stringify({
      type: "user",
      message: { content: parts.filter((part) => part.type === "text").map((part) => part.text).join("\n") },
    });
  }
  const content = [];
  for (const part of parts) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    if (part.type === "tool") {
      const toolInput = part.state?.input ?? {};
      content.push({
        type: "tool_use",
        input: {
          content: toolInput.content,
          new_string: toolInput.new_string ?? toolInput.newString,
        },
      });
    }
  }
  return JSON.stringify({ type: "assistant", message: { content } });
}).join("\n");

const inspectTurn = (messages) => {
  if (!["linux", "win32"].includes(process.platform)) return null;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "mediocrity-detector-"));
  const transcriptPath = path.join(tempDir, "transcript.jsonl");
  try {
    writeFileSync(transcriptPath, toTranscript(messages));
    const result = spawnSync(binary, [], {
      input: JSON.stringify({ transcript_path: transcriptPath, stop_hook_active: false }),
      encoding: "utf8",
    });
    if (result.status !== 0 || !result.stdout.trim()) return null;
    return JSON.parse(result.stdout);
  } catch {
    return null;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
};

export const MediocrityDetectorPlugin = async ({ client, directory }) => {
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
      const decision = inspectTurn(messages);
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
