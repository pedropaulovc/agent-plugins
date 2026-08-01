import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import {
  SERVER_VERSION,
  SolidWorksDocs,
  TOOL_DEFINITIONS,
  dispatchTool,
} from "./solidworks-docs.mjs";

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function negotiatedProtocolVersion(requested) {
  if (SUPPORTED_PROTOCOL_VERSIONS.has(requested)) return requested;
  return DEFAULT_PROTOCOL_VERSION;
}

export function createMcpHandlers({ docs = new SolidWorksDocs() } = {}) {
  let initialized = false;

  return async function handleMessage(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      if (message?.id !== undefined) respondError(message.id, -32600, "Invalid JSON-RPC request");
      return;
    }

    const isNotification = message.id === undefined;
    const params = message.params ?? {};

    if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;
    if (message.method === "ping") {
      if (!isNotification) respond(message.id, {});
      return;
    }
    if (message.method === "initialize") {
      initialized = true;
      if (!isNotification) {
        respond(message.id, {
          protocolVersion: negotiatedProtocolVersion(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "developing-solidworks-docs", version: SERVER_VERSION },
          instructions: "Use status first when the bundle state is unknown. Use search/glob for discovery, then get_type/get_member/get_example/get_guide for complete content.",
        });
      }
      return;
    }
    if (!initialized && message.method !== "notifications/initialized") {
      if (!isNotification) respondError(message.id, -32002, "Server must be initialized before this request");
      return;
    }
    if (message.method === "tools/list") {
      if (!isNotification) respond(message.id, { tools: TOOL_DEFINITIONS });
      return;
    }
    if (message.method === "tools/call") {
      if (isNotification) return;
      if (typeof params.name !== "string") {
        respondError(message.id, -32602, "tools/call requires a string name");
        return;
      }
      try {
        const result = await dispatchTool(docs, params.name, params.arguments ?? {});
        respond(message.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        console.error(`[solidworks-docs] ${messageText}`);
        respond(message.id, { isError: true, content: [{ type: "text", text: messageText }] });
      }
      return;
    }
    if (!isNotification) respondError(message.id, -32601, `Method not found: ${message.method}`);
  };
}

export async function runMcpServer() {
  const handleMessage = createMcpHandlers();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      console.error(`[solidworks-docs] Invalid JSON input: ${error.message}`);
      continue;
    }
    try {
      await handleMessage(message);
    } catch (error) {
      console.error(`[solidworks-docs] Request failed: ${error instanceof Error ? error.stack : String(error)}`);
      if (message.id !== undefined) respondError(message.id, -32603, "Internal server error");
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMcpServer().catch((error) => {
    console.error(`[solidworks-docs] Fatal error: ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  });
}
