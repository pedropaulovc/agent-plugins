import { pathToFileURL } from "node:url";
import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  SERVER_VERSION,
  SolidWorksDocs,
  TOOL_DEFINITIONS,
  dispatchTool,
} from "./solidworks-docs.mjs";

const SERVER_NAME = "developing-solidworks-docs";
const SERVER_INSTRUCTIONS = "Use status first when the bundle state is unknown. Use search/glob for discovery, then get_type/get_member/get_example/get_guide for complete content.";

function propertySchemaToZod(property) {
  let schema;
  if (property.enum) schema = z.enum(property.enum);
  else if (property.type === "string") schema = z.string();
  else if (property.type === "integer") schema = z.number().int();
  else if (property.type === "number") schema = z.number();
  else if (property.type === "boolean") schema = z.boolean();
  else schema = z.unknown();

  if (property.minLength !== undefined && schema instanceof z.ZodString) schema = schema.min(property.minLength);
  if (property.minimum !== undefined && schema instanceof z.ZodNumber) schema = schema.min(property.minimum);
  if (property.maximum !== undefined && schema instanceof z.ZodNumber) schema = schema.max(property.maximum);
  if (property.description) schema = schema.describe(property.description);
  if (Object.hasOwn(property, "default")) return schema.default(property.default);
  return schema;
}

export function inputSchemaToZodShape(inputSchema) {
  const properties = inputSchema?.properties ?? {};
  const required = new Set(inputSchema?.required ?? []);
  return Object.fromEntries(Object.entries(properties).map(([name, property]) => {
    const schema = propertySchemaToZod(property);
    return [name, required.has(name) || Object.hasOwn(property, "default") ? schema : schema.optional()];
  }));
}

function toolResult(result) {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

function toolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[solidworks-docs] ${message}`);
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function createMcpServer({ docs = new SolidWorksDocs() } = {}) {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  for (const definition of TOOL_DEFINITIONS) {
    server.registerTool(
      definition.name,
      { description: definition.description, inputSchema: inputSchemaToZodShape(definition.inputSchema) },
      async (args) => {
        try {
          return toolResult(await dispatchTool(docs, definition.name, args ?? {}));
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  return server;
}

export async function runMcpServer({ docs } = {}) {
  const server = createMcpServer({ docs });
  await server.connect(new StdioServerTransport());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMcpServer().catch((error) => {
    console.error(`[solidworks-docs] Fatal error: ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  });
}
