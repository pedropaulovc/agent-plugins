import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

export const SERVER_VERSION = "0.9.1";
export const REPOSITORY = "pedropaulovc/offline-solidworks-api-docs";
export const XML_NAMESPACE = "urn:solidworks:offline-xmldoc:1";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_UNCOMPRESSED_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_UNCOMPRESSED_TOTAL_BYTES = 512 * 1024 * 1024;
const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;

const KIND_BY_PREFIX = { T: "type", M: "method", P: "property", F: "field", E: "event", N: "namespace", "!": "error" };
const TOOL_LIMIT_SCHEMA = { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT };

function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

export const TOOL_DEFINITIONS = [
  { name: "status", description: "Show the cached SolidWorks XMLDoc bundle, release, extracted files, and indexed counts. Downloads the latest release when no usable cache exists.", inputSchema: objectSchema({}) },
  { name: "refresh", description: "Fetch the latest SolidWorks.Interop.xmldoc.zip release asset, replace the cache, unpack it, and rebuild the semantic index.", inputSchema: objectSchema({}) },
  { name: "glob", description: "Match virtual documentation paths with a glob pattern. Paths include types/, members/, examples/, guides/, and files/ entries.", inputSchema: objectSchema({ pattern: { type: "string", minLength: 1 }, caseSensitive: { type: "boolean", default: false }, limit: TOOL_LIMIT_SCHEMA }, ["pattern"]) },
  { name: "search", description: "Full-text search the SolidWorks XMLDoc bundle, including signatures, member documentation, embedded and catalog examples, and programming guides.", inputSchema: objectSchema({ query: { type: "string", minLength: 1 }, caseSensitive: { type: "boolean", default: false }, scope: { type: "string", enum: ["all", "types", "members", "examples", "guides", "files"], default: "all" }, assembly: { type: "string" }, kind: { type: "string", enum: ["type", "enum", "method", "property", "field", "event", "member"] }, language: { type: "string" }, limit: TOOL_LIMIT_SCHEMA }, ["query"]) },
  { name: "list_assemblies", description: "List the SolidWorks interop assemblies and the number of indexed types and members in each.", inputSchema: objectSchema({}) },
  { name: "list_types", description: "List indexed API types by name, assembly, or enum/type kind.", inputSchema: objectSchema({ query: { type: "string" }, assembly: { type: "string" }, kind: { type: "string", enum: ["all", "type", "enum"], default: "all" }, limit: TOOL_LIMIT_SCHEMA }) },
  { name: "get_type", description: "Fetch one API type, including documentation, complete member summaries, signatures, example links, and optional raw XML.", inputSchema: objectSchema({ name: { type: "string", minLength: 1 }, assembly: { type: "string" }, includeMembers: { type: "boolean", default: true }, memberLimit: TOOL_LIMIT_SCHEMA, includeRawXml: { type: "boolean", default: false } }, ["name"]) },
  { name: "list_members", description: "List methods, properties, fields, events, and other members belonging to a type, with signatures and summaries.", inputSchema: objectSchema({ type: { type: "string", minLength: 1 }, query: { type: "string" }, kind: { type: "string", enum: ["all", "method", "property", "field", "event", "member"], default: "all" }, limit: TOOL_LIMIT_SCHEMA }, ["type"]) },
  { name: "get_member", description: "Fetch one API member by XMLDoc ID, full name, short name, or type/member name. Returns full documentation, parameters, signatures, examples, and optional raw XML.", inputSchema: objectSchema({ name: { type: "string", minLength: 1 }, type: { type: "string" }, assembly: { type: "string" }, kind: { type: "string", enum: ["all", "method", "property", "field", "event", "member"], default: "all" }, includeRawXml: { type: "boolean", default: false } }, ["name"]) },
  { name: "list_enums", description: "List enum types and their member counts. Use get_enum to fetch all enum values and descriptions.", inputSchema: objectSchema({ query: { type: "string" }, assembly: { type: "string" }, limit: TOOL_LIMIT_SCHEMA }) },
  { name: "get_enum", description: "Fetch an enum type and its documented values, including integer/value descriptions when present.", inputSchema: objectSchema({ name: { type: "string", minLength: 1 }, assembly: { type: "string" }, includeRawXml: { type: "boolean", default: false } }, ["name"]) },
  { name: "list_examples", description: "List multilingual SolidWorks examples from the companion catalog or embedded member documentation, optionally filtered by member, language, or text.", inputSchema: objectSchema({ query: { type: "string" }, member: { type: "string" }, language: { type: "string" }, limit: TOOL_LIMIT_SCHEMA }) },
  { name: "get_example", description: "Fetch a complete example by catalog ID, source path, title, or virtual examples/ path.", inputSchema: objectSchema({ name: { type: "string", minLength: 1 }, includeRawXml: { type: "boolean", default: false } }, ["name"]) },
  { name: "list_guides", description: "List programming and how-to guide pages embedded in the companion guide catalog.", inputSchema: objectSchema({ query: { type: "string" }, root: { type: "string" }, limit: TOOL_LIMIT_SCHEMA }) },
  { name: "get_guide", description: "Fetch a complete Markdown programming or how-to guide by guide ID, source path, or title.", inputSchema: objectSchema({ name: { type: "string", minLength: 1 }, includeRawXml: { type: "boolean", default: false } }, ["name"]) },
];

function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(number)));
}
function normalizePath(value) { return String(value ?? "").replaceAll("\\", "/").replace(/^\/+/, ""); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function decodeXml(value) {
  return String(value ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16))).replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number(decimal))).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function parseAttributes(value) {
  const attributes = {};
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([\s\S]*?)"|'([\s\S]*?)')/g;
  for (const match of String(value ?? "").matchAll(pattern)) attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? "");
  return attributes;
}
function qualifiedTag(localName) { return `(?:[A-Za-z_][\\w.-]*:)?${localName}`; }
function collectElements(source, localName) {
  const pattern = new RegExp(`<${qualifiedTag(localName)}\\b([^>]*)>([\\s\\S]*?)</${qualifiedTag(localName)}>`, "gi");
  return [...String(source ?? "").matchAll(pattern)].map((match) => ({ attributes: parseAttributes(match[1]), inner: match[2], raw: match[0], index: match.index ?? 0 }));
}
function collectSelfClosingElements(source, localName) {
  const pattern = new RegExp(`<${qualifiedTag(localName)}\\b([^>]*)\\/\\s*>`, "gi");
  return [...String(source ?? "").matchAll(pattern)].map((match) => ({ attributes: parseAttributes(match[1]), inner: "", raw: match[0], index: match.index ?? 0 }));
}
function firstElement(source, localName) { return collectElements(source, localName)[0] ?? null; }
function elementText(source, localName, preserveWhitespace = false) { const element = firstElement(source, localName); return element ? textFromXml(element.inner, preserveWhitespace) : null; }
function textFromXml(source, preserveWhitespace = false) {
  let value = String(source ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<\s*(?:see|seealso)\b([^>]*)\/\s*>/gi, (_, rawAttributes) => shortReference(parseAttributes(rawAttributes).cref ?? parseAttributes(rawAttributes).href ?? ""))
    .replace(/<\s*(?:see|seealso)\b[^>]*>([\s\S]*?)<\/\s*(?:see|seealso)\s*>/gi, "$1")
    .replace(/<\s*(?:paramref|typeparamref)\b([^>]*)\/\s*>/gi, (_, rawAttributes) => parseAttributes(rawAttributes).name ?? "")
    .replace(/<\s*(?:code|c)\b[^>]*>/gi, "")
    .replace(/<\s*\/(?:code|c)\s*>/gi, "")
    .replace(/<[^>]+>/g, "");
  value = decodeXml(value).replace(/\r\n?/g, "\n");
  if (preserveWhitespace) return value.trim();
  return value.split("\n").map((line) => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
function rawContentText(source) {
  const cdata = [...String(source ?? "").matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((match) => match[1]).join("");
  if (cdata) return cdata.replace(/\r\n?/g, "\n").trim();
  return textFromXml(source, true);
}
function shortReference(value) { const reference = String(value ?? "").replace(/^[A-Z]:/, "").split("(")[0]; return reference.slice(reference.lastIndexOf(".") + 1) || reference; }
function parseParameters(inner, localName = "param") { return collectElements(inner, localName).map((element) => ({ name: element.attributes.name ?? "", description: textFromXml(element.inner) })).filter((parameter) => parameter.name); }
function parseSignature(inner) {
  const elements = [...collectSelfClosingElements(inner, "signature"), ...collectElements(inner, "signature")].sort((left, right) => left.index - right.index);
  const element = elements[0];
  if (!element) return null;
  const parameters = [...collectSelfClosingElements(element.inner, "parameter"), ...collectElements(element.inner, "parameter")].sort((left, right) => left.index - right.index).map((parameter) => ({ name: parameter.attributes.name ?? "", type: parameter.attributes.type ?? "", direction: parameter.attributes.direction ?? null }));
  return { kind: element.attributes.kind ?? null, display: element.attributes.display ?? null, returnType: element.attributes["return-type"] ?? null, parameters };
}
function parseExampleRefs(inner) {
  const elements = [...collectSelfClosingElements(inner, "example-ref"), ...collectElements(inner, "example-ref")].sort((left, right) => left.index - right.index);
  return elements.map((element) => ({ id: normalizePath(element.attributes.id ?? element.attributes.source ?? "").replace(/^\//, ""), language: element.attributes.language ?? null, source: element.attributes.source ?? null })).filter((reference) => reference.id);
}
function parseExamples(inner, ownerId) {
  return collectElements(inner, "example").map((element, index) => {
    const source = element.attributes["sw:source"] ?? element.attributes.source ?? "";
    const id = normalizePath(source).replace(/^\//, "") || `${ownerId}#example-${index + 1}`;
    const contentElement = firstElement(element.inner, "content");
    return { id, title: element.attributes["sw:title"] ?? element.attributes.title ?? id, language: element.attributes["sw:language"] ?? element.attributes.language ?? "Unknown", source: source || null, content: contentElement ? rawContentText(contentElement.inner) : textFromXml(element.inner, true), memberIds: [ownerId], rawXml: element.raw, embedded: true };
  });
}
function parseMember(element, assembly, sourceFile) {
  const id = element.attributes.name ?? "";
  const separator = id.indexOf(":");
  const prefix = separator > 0 ? id.slice(0, separator) : "";
  const fullName = separator > 0 ? id.slice(separator + 1) : id;
  const kind = KIND_BY_PREFIX[prefix] ?? "member";
  const summary = elementText(element.inner, "summary");
  const enumValueText = summary?.match(/^[-+]?\d+(?:\.\d+)?(?=\s*(?:;|$))/)?.[0] ?? null;
  return { id, prefix, kind, fullName, shortName: shortReference(fullName), assembly, sourceFile, summary, enumValue: enumValueText === null ? null : Number(enumValueText), remarks: elementText(element.inner, "remarks"), returns: elementText(element.inner, "returns"), value: elementText(element.inner, "value"), availability: elementText(element.inner, "availability"), parameters: parseParameters(element.inner, "param"), typeParameters: parseParameters(element.inner, "typeparam"), exceptions: collectElements(element.inner, "exception").map((exception) => ({ cref: exception.attributes.cref ?? null, description: textFromXml(exception.inner) })), seeAlso: [...collectElements(element.inner, "seealso"), ...collectSelfClosingElements(element.inner, "seealso")].map((reference) => ({ cref: reference.attributes.cref ?? null, href: reference.attributes.href ?? null, text: textFromXml(reference.inner) })), signature: parseSignature(element.inner), exampleRefs: parseExampleRefs(element.inner), examples: parseExamples(element.inner, id), typeFullName: kind === "type" ? fullName : containingType(fullName), rawXml: element.raw, searchText: textFromXml(element.raw, true) };
}
function containingType(fullName) { const withoutParameters = String(fullName ?? "").split("(")[0]; const separator = withoutParameters.lastIndexOf("."); return separator > 0 ? withoutParameters.slice(0, separator) : null; }
function isTypeRecord(member) { return member.prefix === "T"; }
function parseCompanionExample(element) {
  const contentElement = firstElement(element.inner, "content");
  const id = normalizePath(element.attributes.id ?? element.attributes.source ?? "").replace(/^\//, "");
  return { id, title: element.attributes.title ?? id, language: element.attributes.language ?? "Unknown", source: element.attributes.source ?? null, content: contentElement ? rawContentText(contentElement.inner) : "", memberIds: [...collectSelfClosingElements(element.inner, "applies-to"), ...collectElements(element.inner, "applies-to")].map((reference) => reference.attributes.cref ?? "").filter(Boolean), rawXml: element.raw, embedded: false };
}
function parseGuide(element) {
  const contentElement = firstElement(element.inner, "content");
  const id = normalizePath(element.attributes.id ?? element.attributes.source ?? "");
  return { id, title: element.attributes.title ?? id, source: element.attributes.source ?? null, root: element.attributes.root ?? null, format: contentElement?.attributes.format ?? element.attributes.format ?? "markdown", content: contentElement ? rawContentText(contentElement.inner) : textFromXml(element.inner, true), rawXml: element.raw };
}
async function listFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) { const path = join(directory, entry.name); if (entry.isDirectory()) await visit(path); if (entry.isFile()) files.push(path); }
  }
  await visit(root);
  return files.sort();
}
async function loadIndex(extractedDir, metadata) {
  const files = await listFiles(extractedDir);
  const state = { metadata, files: [], rawFiles: new Map(), assemblies: new Map(), members: [], membersById: new Map(), types: [], typesByName: new Map(), examples: [], examplesById: new Map(), guides: [], guidesById: new Map(), virtualEntries: [] };
  for (const filePath of files) {
    const sourceFile = relative(extractedDir, filePath).replaceAll("\\", "/");
    state.files.push(sourceFile);
    if (extname(filePath).toLowerCase() !== ".xml") continue;
    const xml = await fs.readFile(filePath, "utf8");
    state.rawFiles.set(sourceFile, xml);
    if (basename(filePath).toLowerCase() === "solidworks.interop.examples.xml") { for (const element of collectElements(xml, "example")) { const example = parseCompanionExample(element); if (example.id) addExample(state, example); } continue; }
    if (basename(filePath).toLowerCase() === "solidworks.interop.guides.xml") { for (const element of collectElements(xml, "guide")) { const guide = parseGuide(element); if (guide.id) { state.guides.push(guide); state.guidesById.set(guide.id.toLowerCase(), guide); } } continue; }
    const assemblyName = elementText(xml, "name") ?? basename(filePath, ".xml");
    if (!state.assemblies.has(assemblyName)) state.assemblies.set(assemblyName, { name: assemblyName, sourceFiles: [] });
    state.assemblies.get(assemblyName).sourceFiles.push(sourceFile);
    for (const element of collectElements(xml, "member")) {
      const member = parseMember(element, assemblyName, sourceFile);
      if (!member.id) continue;
      const existing = state.membersById.get(member.id);
      if (existing) { existing.exampleRefs.push(...member.exampleRefs); existing.examples.push(...member.examples); existing.exampleRefs = dedupeRefs(existing.exampleRefs); existing.examples = dedupeExamples(existing.examples); continue; }
      state.members.push(member); state.membersById.set(member.id, member);
      if (member.kind === "type") { state.types.push(member); state.typesByName.set(member.fullName.toLowerCase(), member); }
      for (const example of member.examples) addExample(state, example);
    }
  }
  for (const member of state.members) { member.exampleRefs = dedupeRefs(member.exampleRefs); member.exampleIds = unique(member.exampleRefs.map((reference) => reference.id).concat(member.examples.map((example) => example.id))); for (const exampleId of member.exampleIds) { const example = state.examplesById.get(exampleId.toLowerCase()); if (example) example.memberIds = unique(example.memberIds.concat(member.id)); } }
  for (const type of state.types) { type.memberIds = state.members.filter((member) => !isTypeRecord(member) && member.typeFullName?.toLowerCase() === type.fullName.toLowerCase()).map((member) => member.id); type.memberCount = type.memberIds.length; type.isEnum = inferEnum(type, state.members); type.kind = type.isEnum ? "enum" : "type"; type.exampleIds = unique(type.exampleRefs.map((reference) => reference.id).concat(type.examples.map((example) => example.id))); }
  state.types.sort(compareName); state.members.sort(compareName); state.examples.sort(compareName); state.guides.sort(compareName); state.files.sort(); state.virtualEntries = buildVirtualEntries(state); return state;
}
function addExample(state, example) {
  const key = example.id.toLowerCase();
  const existing = state.examplesById.get(key);
  if (!existing) { state.examples.push(example); state.examplesById.set(key, example); return; }
  existing.memberIds = unique(existing.memberIds.concat(example.memberIds)); if (!existing.content && example.content) existing.content = example.content; if (!existing.title && example.title) existing.title = example.title; if (existing.language === "Unknown" && example.language) existing.language = example.language; if (!existing.rawXml && example.rawXml) existing.rawXml = example.rawXml;
}
function dedupeRefs(refs) { const seen = new Set(); return refs.filter((reference) => { const key = `${reference.id.toLowerCase()}|${reference.language ?? ""}|${reference.source ?? ""}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function dedupeExamples(examples) { const seen = new Set(); return examples.filter((example) => { if (seen.has(example.id.toLowerCase())) return false; seen.add(example.id.toLowerCase()); return true; }); }
function inferEnum(type, members) { if (type.fullName.endsWith("_e")) return true; const children = members.filter((member) => member.typeFullName?.toLowerCase() === type.fullName.toLowerCase()); return children.length > 0 && children.every((member) => member.kind === "field") && type.assembly.toLowerCase().endsWith("swconst"); }
function compareName(left, right) { return String(left.name ?? left.fullName ?? left.id).localeCompare(String(right.name ?? right.fullName ?? right.id)); }
function buildVirtualEntries(state) {
  const entries = [];
  for (const file of state.files) entries.push({ path: `files/${file}`, kind: "file", id: file, name: file });
  for (const type of state.types) {
    const typePath = `${type.isEnum ? "enums" : "types"}/${type.assembly}/${type.shortName}`;
    entries.push({ path: typePath, aliases: [`${type.isEnum ? "enums" : "types"}/${type.shortName}`, `${type.isEnum ? "enums" : "types"}/${type.shortName}${type.isEnum ? ".md" : "/_overview.md"}`, `types/${type.assembly}/${type.fullName}`, `types/${type.assembly}/${type.fullName.replaceAll(".", "/")}`], kind: type.kind, id: type.id, name: type.shortName, assembly: type.assembly });
  }
  for (const member of state.members.filter((item) => !isTypeRecord(item))) {
    const typeName = member.typeFullName?.split(".").at(-1) ?? "global";
    entries.push({ path: `members/${member.assembly}/${typeName}/${member.shortName}`, aliases: [`members/${member.assembly}/${member.fullName}`, `members/${typeName}/${member.shortName}`, `types/${typeName}/${member.shortName}`, `types/${typeName}/${member.shortName}.md`], kind: member.kind, id: member.id, name: member.shortName, assembly: member.assembly });
  }
  for (const example of state.examples) entries.push({ path: `examples/${example.id}`, kind: "example", id: example.id, name: example.title });
  for (const guide of state.guides) entries.push({ path: `guides/${guide.id}`, kind: "guide", id: guide.id, name: guide.title });
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}
function globToRegExp(pattern, caseSensitive = false) {
  let expression = "^"; const normalized = normalizePath(pattern);
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        if (normalized[index + 2] === "/") { expression += "(?:.*/)?"; index += 2; } else { expression += ".*"; index += 1; }
      } else expression += "[^/]*";
      continue;
    }
    if (character === "?") { expression += "[^/]"; continue; }
    expression += /[\\^$+?.()|{}[\]]/.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${expression}$`, caseSensitive ? "" : "i");
}
function memberPath(member) { const typeName = member.typeFullName?.split(".").at(-1) ?? "global"; return `members/${member.assembly}/${typeName}/${member.shortName}`; }
function typePath(type) { return `${type.isEnum ? "enums" : "types"}/${type.assembly}/${type.shortName}`; }
function memberSummary(member) { return { id: member.id, name: member.shortName, fullName: member.fullName, kind: member.kind, assembly: member.assembly, type: member.typeFullName, summary: member.summary, enumValue: member.enumValue, value: member.value, remarks: member.remarks, signature: member.signature, examples: member.exampleIds ?? [], path: memberPath(member) }; }
function typeSummary(type) { return { id: type.id, name: type.shortName, fullName: type.fullName, kind: type.kind, assembly: type.assembly, summary: type.summary, signature: type.signature, memberCount: type.memberCount ?? 0, examples: type.exampleIds ?? [], path: typePath(type) }; }
function exampleSummary(example) { return { id: example.id, title: example.title, language: example.language, source: example.source, members: example.memberIds, path: `examples/${example.id}` }; }
function guideSummary(guide) { return { id: guide.id, title: guide.title, source: guide.source, root: guide.root, format: guide.format, path: `guides/${guide.id}` }; }
function matchesText(value, query, caseSensitive = false) { const left = String(value ?? ""); const right = String(query ?? ""); return caseSensitive ? left.includes(right) : left.toLowerCase().includes(right.toLowerCase()); }
function matchesAssembly(value, assembly, caseSensitive = false) { return !assembly || (caseSensitive ? String(value ?? "") === String(assembly) : String(value ?? "").toLowerCase() === String(assembly).toLowerCase()); }
function snippet(text, query, radius = 180, caseSensitive = false) { const source = String(text ?? "").replace(/\s+/g, " ").trim(); const haystack = caseSensitive ? source : source.toLowerCase(); const needle = caseSensitive ? String(query) : String(query).toLowerCase(); const index = haystack.indexOf(needle); if (index < 0) return source.slice(0, radius * 2); const start = Math.max(0, index - radius); const end = Math.min(source.length, index + String(query).length + radius); return `${start > 0 ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`; }
function searchText(values) { return values.flat(Infinity).filter((value) => value !== null && value !== undefined && typeof value !== "object").join(" "); }
function linkedExamples(state, ids = []) { return ids.map((id) => state.examplesById.get(String(id).toLowerCase())).filter(Boolean); }
function exampleMatchesAssembly(state, example, assembly, caseSensitive = false) {
  if (!assembly) return true;
  return example.memberIds.some((memberId) => {
    const member = state.membersById.get(memberId);
    return member && matchesAssembly(member.assembly, assembly, caseSensitive);
  });
}
function memberSearchText(member, state) {
  const signature = member.signature ?? {};
  const signatureParameters = (signature.parameters ?? []).flatMap((parameter) => [parameter.name, parameter.type, parameter.direction]);
  const documentationParameters = (member.parameters ?? []).flatMap((parameter) => [parameter.name, parameter.description]);
  const references = [...(member.exampleRefs ?? []).flatMap((reference) => [reference.id, reference.language, reference.source]), ...(member.seeAlso ?? []).flatMap((reference) => [reference.cref, reference.href, reference.text]), ...(member.exceptions ?? []).flatMap((exception) => [exception.cref, exception.description])];
  const examples = [...(member.examples ?? []), ...linkedExamples(state, member.exampleIds)].flatMap((example) => [example.id, example.title, example.language, example.source, example.content]);
  return searchText([member.searchText, member.id, member.fullName, member.shortName, member.summary, member.remarks, member.returns, member.value, member.availability, signature.kind, signature.display, signature.returnType, signatureParameters, documentationParameters, references, examples]);
}
function typeSearchText(type, state) {
  const signature = type.signature ?? {};
  const examples = linkedExamples(state, type.exampleIds).flatMap((example) => [example.id, example.title, example.language, example.source, example.content]);
  return searchText([type.searchText, type.id, type.fullName, type.shortName, type.summary, type.remarks, type.returns, type.value, type.availability, signature.kind, signature.display, signature.returnType, type.seeAlso?.flatMap((reference) => [reference.cref, reference.href, reference.text]), examples]);
}
function matchesTypeQualifier(member, query) {
  if (!query) return true;
  const normalized = normalizePath(query).replace(/^types\//i, "").replaceAll("/", ".").toLowerCase();
  const fullName = String(member.typeFullName ?? "").toLowerCase();
  return fullName === normalized || fullName.endsWith(`.${normalized}`) || fullName.split(".").at(-1) === normalized;
}
function resolveType(state, name, assembly) {
  let rawQuery = normalizePath(String(name ?? "").trim()).replace(/^(?:types|enums)\//i, "").replace(/\/_overview\.md$/i, "").replace(/\.md$/i, "").replace(/^T:/i, "");
  const segments = rawQuery.split("/").filter(Boolean);
  let requestedAssembly = assembly;
  if (segments.length > 1 && (!assembly || matchesAssembly(segments[0], assembly))) {
    requestedAssembly ??= segments.shift();
  }
  const query = segments.join(".") || rawQuery;
  const candidates = state.types.filter((type) => matchesAssembly(type.assembly, requestedAssembly));
  const exact = candidates.filter((type) => [type.fullName, type.id.slice(2)].some((value) => value.toLowerCase() === query.toLowerCase()));
  if (exact.length) return exact;
  const short = candidates.filter((type) => type.shortName.toLowerCase() === query.toLowerCase());
  if (short.length) return short;
  return candidates.filter((type) => matchesText(type.fullName, query) || matchesText(type.shortName, query));
}
function resolveMembers(state, name, options = {}) {
  const rawQuery = normalizePath(String(name ?? "").trim()).replace(/^(?:members|types)\//i, "").replace(/\.md$/i, "");
  const segments = rawQuery.split("/").filter(Boolean);
  let requestedAssembly = options.assembly;
  if (segments.length > 1 && (!requestedAssembly || matchesAssembly(segments[0], requestedAssembly))) {
    const knownAssembly = [...state.assemblies.keys()].some((candidate) => matchesAssembly(candidate, segments[0]));
    if (requestedAssembly || knownAssembly) {
      requestedAssembly ??= segments.shift();
      if (options.assembly) segments.shift();
    }
  }
  const query = segments.length > 1 ? segments.at(-1) : segments[0] ?? rawQuery;
  const pathTypeQuery = segments.length > 1 ? segments.slice(0, -1).join(".") : null;
  const typeQuery = pathTypeQuery ?? options.type;
  const kind = options.kind && options.kind !== "all" && options.kind !== "member" ? options.kind : null;
  const candidates = state.members.filter((member) => !isTypeRecord(member) && matchesAssembly(member.assembly, requestedAssembly) && (!kind || member.kind === kind) && matchesTypeQualifier(member, typeQuery));
  const exact = candidates.filter((member) => [member.id, member.fullName, member.shortName].some((value) => String(value).toLowerCase() === query.toLowerCase()));
  if (exact.length) return exact;
  return candidates.filter((member) => matchesText(member.fullName, query) || matchesText(member.shortName, query));
}
function resolveExample(state, name) { const query = normalizePath(String(name ?? "").trim()).replace(/^examples\//i, ""); const exact = state.examples.filter((example) => [example.id, example.source ?? ""].some((value) => value.toLowerCase() === query.toLowerCase())); if (exact.length) return exact; return state.examples.filter((example) => matchesText(example.id, query) || matchesText(example.title, query)); }
function resolveGuide(state, name) { const query = normalizePath(String(name ?? "").trim()).replace(/^guides\//i, ""); const exact = state.guides.filter((guide) => [guide.id, guide.source ?? ""].some((value) => value.toLowerCase() === query.toLowerCase())); if (exact.length) return exact; return state.guides.filter((guide) => matchesText(guide.id, query) || matchesText(guide.title, query)); }
function expandedMember(member, includeRawXml) { const result = { ...memberSummary(member), remarks: member.remarks, returns: member.returns, value: member.value, availability: member.availability, parameters: member.parameters, typeParameters: member.typeParameters, exceptions: member.exceptions, seeAlso: member.seeAlso, exampleRefs: member.exampleRefs }; if (includeRawXml) result.rawXml = member.rawXml; return result; }
function expandedType(state, type, options) { const result = { ...typeSummary(type), remarks: type.remarks, returns: type.returns, value: type.value, availability: type.availability, parameters: type.parameters, typeParameters: type.typeParameters, exceptions: type.exceptions, seeAlso: type.seeAlso, exampleRefs: type.exampleRefs }; if (options.includeMembers !== false) { const limit = clampLimit(options.memberLimit, MAX_LIMIT); const members = state.members.filter((member) => type.memberIds?.includes(member.id)).slice(0, limit); result.members = members.map(memberSummary); result.membersShown = members.length; result.membersTruncated = (type.memberIds?.length ?? 0) > members.length; } if (options.includeRawXml) result.rawXml = type.rawXml; return result; }
function searchState(state, options) {
  const query = String(options.query ?? "").trim(); const scope = options.scope ?? "all"; const limit = clampLimit(options.limit); const caseSensitive = options.caseSensitive === true; const results = [];
  const add = (kind, label, text, path, extra = {}) => { if (results.length >= limit || !matchesText(text, query, caseSensitive)) return; results.push({ kind, label, path, snippet: snippet(text, query, 180, caseSensitive), ...extra }); };
  if (scope === "all" || scope === "types") for (const type of state.types) { if (!matchesAssembly(type.assembly, options.assembly, caseSensitive)) continue; if (options.kind && type.kind !== options.kind) continue; add(type.kind, type.fullName, typeSearchText(type, state), typePath(type), { id: type.id, assembly: type.assembly }); }
  if (scope === "all" || scope === "members") for (const member of state.members.filter((item) => !isTypeRecord(item))) { if (!matchesAssembly(member.assembly, options.assembly, caseSensitive)) continue; if (options.kind && options.kind !== "member" && member.kind !== options.kind) continue; add(member.kind, member.fullName, memberSearchText(member, state), memberPath(member), { id: member.id, assembly: member.assembly, type: member.typeFullName }); }
  if (scope === "all" || scope === "examples") for (const example of state.examples) { if (!exampleMatchesAssembly(state, example, options.assembly, caseSensitive)) continue; if (options.language && !matchesText(example.language, options.language, caseSensitive)) continue; add("example", example.title, `${example.id} ${example.title} ${example.language} ${example.source ?? ""} ${example.memberIds.join(" ")} ${example.content}`, `examples/${example.id}`, { id: example.id, language: example.language, members: example.memberIds }); }
  if (scope === "all" || scope === "guides") for (const guide of state.guides) add("guide", guide.title, `${guide.id} ${guide.title} ${guide.content}`, `guides/${guide.id}`, { id: guide.id, root: guide.root });
  if (scope === "files") for (const [file, content] of state.rawFiles) add("file", file, content, `files/${file}`, { id: file });
  return { query, scope, caseSensitive, count: results.length, results };
}
function statusFromState(state) { const assemblies = [...state.assemblies.values()].map((assembly) => ({ name: assembly.name, sourceFiles: assembly.sourceFiles, types: state.types.filter((type) => type.assembly === assembly.name).length, members: state.members.filter((member) => member.assembly === assembly.name && !isTypeRecord(member)).length })); return { ...state.metadata, extractedFiles: state.files, counts: { assemblies: assemblies.length, types: state.types.length, enums: state.types.filter((type) => type.isEnum).length, members: state.members.filter((member) => !isTypeRecord(member)).length, examples: state.examples.length, guides: state.guides.length }, assemblies }; }
function safeCacheRoot(env = process.env) { if (env.SOLIDWORKS_DOCS_CACHE_DIR) return resolve(env.SOLIDWORKS_DOCS_CACHE_DIR); if (env.CLAUDE_PLUGIN_DATA) return join(resolve(env.CLAUDE_PLUGIN_DATA), "solidworks-docs"); if (env.XDG_CACHE_HOME) return join(resolve(env.XDG_CACHE_HOME), "developing-solidworks"); if (process.platform === "win32" && env.LOCALAPPDATA) return join(resolve(env.LOCALAPPDATA), "developing-solidworks"); return join(homedir(), ".cache", "developing-solidworks"); }
async function pathExists(path) { try { await fs.access(path); return true; } catch { return false; } }
async function readJson(path) { try { return JSON.parse(await fs.readFile(path, "utf8")); } catch { return null; } }
function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
function parseDigest(value) { return String(value ?? "").replace(/^sha256:/i, "").toLowerCase(); }
const CACHE_LOCK_RETRY_MS = 50;
const CACHE_LOCK_TIMEOUT_MS = 120_000;
const CACHE_LOCK_STALE_MS = 900_000;
async function acquireCacheLock(cacheDir) {
  await fs.mkdir(cacheDir, { recursive: true });
  const lockPath = join(cacheDir, ".lock");
  const startedAt = Date.now();
  while (true) {
    try {
      return { handle: await fs.open(lockPath, "wx"), lockPath };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const lockStats = await fs.stat(lockPath);
        if (Date.now() - lockStats.mtimeMs > CACHE_LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch (lockError) {
        if (lockError.code !== "ENOENT") throw lockError;
        continue;
      }
      if (Date.now() - startedAt >= CACHE_LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for SolidWorks documentation cache lock: ${cacheDir}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, CACHE_LOCK_RETRY_MS));
    }
  }
}
async function withCacheLock(cacheDir, callback) {
  const { handle, lockPath } = await acquireCacheLock(cacheDir);
  try {
    return await callback();
  } finally {
    await handle.close();
    await fs.rm(lockPath, { force: true });
  }
}
async function cleanupReleaseDirectories(cacheDir, keepDir) {
  const extractedRoot = join(cacheDir, "extracted");
  let entries;
  try {
    entries = await fs.readdir(extractedRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const keepPath = resolve(keepDir);
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("release-"))
    .map(async (entry) => {
      const entryPath = join(extractedRoot, entry.name);
      if (resolve(entryPath) === keepPath) return;
      await fs.rm(entryPath, { recursive: true, force: true });
    }));
}
function releaseCacheDirectory(cacheDir, tag, digest) {
  const safeTag = String(tag ?? "latest").replace(/[^A-Za-z0-9._-]/g, "_");
  return join(cacheDir, "extracted", `release-${safeTag}-${digest.slice(0, 16)}`);
}
export function selectReleaseAsset(assets = []) { const zipAssets = assets.filter((asset) => /\.zip$/i.test(asset.name ?? "") && /xmldoc/i.test(asset.name ?? "")); if (!zipAssets.length) return null; const rank = (name) => /^offline-solidworks-docs\.xmldoc\.zip$/i.test(name) ? 0 : /^SolidWorks\.Interop\.xmldoc\.v?[\w.-]+\.zip$/i.test(name) ? 1 : /SolidWorks\.Interop\.xmldoc/i.test(name) ? 2 : 3; return [...zipAssets].sort((left, right) => rank(left.name) - rank(right.name) || left.name.localeCompare(right.name))[0]; }
async function fetchJson(url, fetchImpl) { const response = await fetchImpl(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "developing-solidworks-mcp" } }); if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`); return response.json(); }
async function downloadBuffer(url, fetchImpl) { const response = await fetchImpl(url, { headers: { Accept: "application/zip", "User-Agent": "developing-solidworks-mcp" } }); if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${url}`); return Buffer.from(await response.arrayBuffer()); }
function findEndOfCentralDirectory(buffer) { const minimum = Math.max(0, buffer.length - 65_557); for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) if (buffer.readUInt32LE(offset) === 0x06054b50) return offset; throw new Error("Invalid ZIP: end-of-central-directory record not found"); }
export async function unpackZip(buffer, targetDir) { const end = findEndOfCentralDirectory(buffer); const entryCount = buffer.readUInt16LE(end + 10); const centralOffset = buffer.readUInt32LE(end + 16); if (entryCount === 0xffff || centralOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported by the bundled extractor"); await fs.mkdir(targetDir, { recursive: true }); let offset = centralOffset; let totalBytes = 0; const root = resolve(targetDir); for (let index = 0; index < entryCount; index += 1) { if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP central-directory entry"); const flags = buffer.readUInt16LE(offset + 8); const method = buffer.readUInt16LE(offset + 10); const compressedSize = buffer.readUInt32LE(offset + 20); const uncompressedSize = buffer.readUInt32LE(offset + 24); const nameLength = buffer.readUInt16LE(offset + 28); const extraLength = buffer.readUInt16LE(offset + 30); const commentLength = buffer.readUInt16LE(offset + 32); const localOffset = buffer.readUInt32LE(offset + 42); const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength).replaceAll("\\", "/"); offset += 46 + nameLength + extraLength + commentLength; if (name.endsWith("/")) continue; if ((flags & 0x1) !== 0) throw new Error(`Encrypted ZIP entry is not supported: ${name}`); if (uncompressedSize > MAX_UNCOMPRESSED_ENTRY_BYTES || totalBytes + uncompressedSize > MAX_UNCOMPRESSED_TOTAL_BYTES) throw new Error(`ZIP entry exceeds the safe extraction limit: ${name}`); if (name.startsWith("/") || name.split("/").includes("..")) throw new Error(`Unsafe ZIP entry path: ${name}`); if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Invalid ZIP local header: ${name}`); const localNameLength = buffer.readUInt16LE(localOffset + 26); const localExtraLength = buffer.readUInt16LE(localOffset + 28); const dataStart = localOffset + 30 + localNameLength + localExtraLength; const compressed = buffer.subarray(dataStart, dataStart + compressedSize); let content; if (method === 0) content = compressed; else if (method === 8) content = inflateRawSync(compressed); else throw new Error(`Unsupported ZIP compression method ${method}: ${name}`); if (content.length !== uncompressedSize) throw new Error(`ZIP size mismatch: ${name}`); totalBytes += content.length; const outputPath = resolve(targetDir, name); if (outputPath !== root && !outputPath.startsWith(`${root}/`) && !outputPath.startsWith(`${root}\\`)) throw new Error(`Unsafe ZIP output path: ${name}`); await fs.mkdir(dirname(outputPath), { recursive: true }); await fs.writeFile(outputPath, content); } }

export class SolidWorksDocs {
  constructor(options = {}) { this.env = options.env ?? process.env; this.fetchImpl = options.fetchImpl ?? globalThis.fetch; this.cacheDir = resolve(options.cacheDir ?? safeCacheRoot(this.env)); this.bundlePath = options.bundlePath ?? this.env.SOLIDWORKS_DOCS_BUNDLE ?? null; this.releaseApi = options.releaseApi ?? RELEASE_API; this.state = null; this.bundleMetadata = null; }
  async ensure(force = false) {
    if (!force && this.state && this.bundleMetadata) return this.state;
    return withCacheLock(this.cacheDir, async () => {
      const metadata = force || !this.bundleMetadata || !this.state ? await this.ensureBundle(force) : this.bundleMetadata;
      this.bundleMetadata = metadata;
      if (!this.state || this.state.metadata.digest !== metadata.digest || this.state.metadata.extractedDir !== metadata.extractedDir) this.state = await loadIndex(metadata.extractedDir, metadata);
      return this.state;
    });
  }
  async ensureBundle(force = false) {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const metadataPath = join(this.cacheDir, "bundle.json");
    const existing = await readJson(metadataPath);
    const localPath = this.bundlePath ?? this.env.SOLIDWORKS_DOCS_BUNDLE;
    if (localPath) {
      const sourcePath = resolve(localPath);
      const buffer = await fs.readFile(sourcePath);
      const digest = sha256(buffer);
      const extractedDir = join(this.cacheDir, "extracted", `local-${digest.slice(0, 16)}`);
      if (!force && existing?.source === "local" && existing.digest === digest && await pathExists(extractedDir)) return existing;
      await this.replaceBundle({ buffer, metadata: { source: "local", sourcePath, repository: REPOSITORY, tag: "local", assetName: basename(sourcePath), assetUrl: null, digest }, extractedDir, metadataPath });
      return readJson(metadataPath);
    }
    let release;
    try {
      release = await fetchJson(this.releaseApi, this.fetchImpl);
    } catch (error) {
      if (!force && existing?.extractedDir && await pathExists(existing.extractedDir)) return existing;
      throw new Error(`Unable to fetch SolidWorks XMLDoc release metadata: ${error.message}`);
    }
    const asset = selectReleaseAsset(release.assets);
    if (!asset) {
      if (!force && existing?.extractedDir && await pathExists(existing.extractedDir)) return existing;
      throw new Error("The latest SolidWorks release has no xmldoc ZIP asset");
    }
    const tag = release.tag_name ?? "latest";
    const digest = parseDigest(asset.digest);
    const cachedRelease = !force
      && existing?.source === "release"
      && existing.tag === tag
      && existing.assetName === asset.name
      && (!existing.assetUrl || existing.assetUrl === asset.browser_download_url)
      && (!digest || existing.digest === digest)
      && existing.extractedDir
      && await pathExists(existing.extractedDir);
    if (cachedRelease) return existing;
    let buffer;
    try {
      buffer = await downloadBuffer(asset.browser_download_url, this.fetchImpl);
    } catch (error) {
      if (!force && existing?.extractedDir && await pathExists(existing.extractedDir)) return existing;
      throw new Error(`Unable to download SolidWorks XMLDoc bundle: ${error.message}`);
    }
    const actualDigest = sha256(buffer);
    if (digest && digest !== actualDigest) throw new Error(`SolidWorks XMLDoc bundle checksum mismatch: expected ${digest}, got ${actualDigest}`);
    const extractedDir = releaseCacheDirectory(this.cacheDir, tag, actualDigest);
    await this.replaceBundle({ buffer, metadata: { source: "release", sourcePath: null, repository: REPOSITORY, tag, assetName: asset.name, assetUrl: asset.browser_download_url, digest: actualDigest, releaseUrl: release.html_url ?? null }, extractedDir, metadataPath });
    return readJson(metadataPath);
  }
  async replaceBundle({ buffer, metadata, extractedDir, metadataPath }) {
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const temporaryDir = `${extractedDir}.tmp-${suffix}`;
    await fs.rm(temporaryDir, { recursive: true, force: true });
    await fs.mkdir(temporaryDir, { recursive: true });
    try {
      await unpackZip(buffer, temporaryDir);
      if (await pathExists(extractedDir)) await fs.rm(temporaryDir, { recursive: true, force: true });
      else await fs.rename(temporaryDir, extractedDir);
      const completeMetadata = { ...metadata, extractedDir, cachedAt: new Date().toISOString() };
      const temporaryMetadata = `${metadataPath}.tmp-${suffix}`;
      await fs.writeFile(temporaryMetadata, JSON.stringify(completeMetadata, null, 2));
      await fs.rename(temporaryMetadata, metadataPath);
      if (metadata.source === "release") await cleanupReleaseDirectories(this.cacheDir, extractedDir);
    } catch (error) {
      await fs.rm(temporaryDir, { recursive: true, force: true });
      throw error;
    }
  }
  async status() { return statusFromState(await this.ensure(false)); }
  async refresh() { this.state = null; this.bundleMetadata = null; return statusFromState(await this.ensure(true)); }
  async glob(pattern, limit, caseSensitive = false) { const state = await this.ensure(false); const regex = globToRegExp(pattern, caseSensitive); const matches = state.virtualEntries.flatMap((entry) => { const matchedPath = [entry.path, ...(entry.aliases ?? [])].find((path) => regex.test(path)); if (!matchedPath) return []; const { aliases: _aliases, ...result } = entry; return [{ ...result, matchedPath }]; }).slice(0, clampLimit(limit)); return { pattern: normalizePath(pattern), caseSensitive, count: matches.length, matches }; }
  async search(options) { return searchState(await this.ensure(false), options); }
  async listAssemblies() { const state = await this.ensure(false); return { count: state.assemblies.size, assemblies: [...state.assemblies.values()].map((assembly) => ({ name: assembly.name, sourceFiles: assembly.sourceFiles, types: state.types.filter((type) => type.assembly === assembly.name).length, members: state.members.filter((member) => member.assembly === assembly.name && !isTypeRecord(member)).length })).sort((left, right) => left.name.localeCompare(right.name)) }; }
  async listTypes(options = {}) { const state = await this.ensure(false); const query = options.query?.trim(); const kind = options.kind ?? "all"; const types = state.types.filter((type) => matchesAssembly(type.assembly, options.assembly) && (kind === "all" || type.kind === kind) && (!query || matchesText(`${type.fullName} ${type.summary}`, query))).slice(0, clampLimit(options.limit)); return { count: types.length, types: types.map(typeSummary) }; }
  async getType(options) { const state = await this.ensure(false); const matches = resolveType(state, options.name, options.assembly); if (matches.length !== 1) return { found: false, matchCount: matches.length, matches: matches.slice(0, MAX_LIMIT).map(typeSummary) }; return { found: true, type: expandedType(state, matches[0], options) }; }
  async listMembers(options) { const state = await this.ensure(false); const types = resolveType(state, options.type, options.assembly); if (types.length !== 1) return { found: false, matchCount: types.length, types: types.slice(0, MAX_LIMIT).map(typeSummary) }; const type = types[0]; const query = options.query?.trim(); const kind = options.kind ?? "all"; const members = state.members.filter((member) => !isTypeRecord(member) && member.typeFullName?.toLowerCase() === type.fullName.toLowerCase() && (kind === "all" || member.kind === kind) && (!query || matchesText(`${member.fullName} ${member.summary} ${member.signature?.display}`, query))).slice(0, clampLimit(options.limit)); return { found: true, type: typeSummary(type), count: members.length, members: members.map(memberSummary) }; }
  async getMember(options) { const state = await this.ensure(false); const matches = resolveMembers(state, options.name, options); if (matches.length !== 1) return { found: false, matchCount: matches.length, matches: matches.slice(0, MAX_LIMIT).map(memberSummary) }; return { found: true, member: expandedMember(matches[0], options.includeRawXml === true) }; }
  async listEnums(options = {}) { return this.listTypes({ ...options, kind: "enum" }); }
  async getEnum(options) { const result = await this.getType({ ...options, includeMembers: true }); if (!result.found) return result; if (result.type.kind === "enum") return result; return { found: false, matchCount: 0, matches: [] }; }
  async listExamples(options = {}) { const state = await this.ensure(false); const query = options.query?.trim(); const member = options.member?.trim(); const examples = state.examples.filter((example) => (!query || matchesText(`${example.id} ${example.title} ${example.language} ${example.content}`, query)) && (!options.language || matchesText(example.language, options.language)) && (!member || example.memberIds.some((id) => matchesText(id, member)))).slice(0, clampLimit(options.limit)); return { count: examples.length, examples: examples.map(exampleSummary) }; }
  async getExample(options) { const state = await this.ensure(false); const matches = resolveExample(state, options.name); if (matches.length !== 1) return { found: false, matchCount: matches.length, matches: matches.slice(0, MAX_LIMIT).map(exampleSummary) }; const example = matches[0]; const result = { ...exampleSummary(example), content: example.content }; if (options.includeRawXml === true) result.rawXml = example.rawXml; return { found: true, example: result }; }
  async listGuides(options = {}) { const state = await this.ensure(false); const query = options.query?.trim(); const guides = state.guides.filter((guide) => (!query || matchesText(`${guide.id} ${guide.title} ${guide.content}`, query)) && (!options.root || guide.root?.toLowerCase() === options.root.toLowerCase())).slice(0, clampLimit(options.limit)); return { count: guides.length, guides: guides.map(guideSummary) }; }
  async getGuide(options) { const state = await this.ensure(false); const matches = resolveGuide(state, options.name); if (matches.length !== 1) return { found: false, matchCount: matches.length, matches: matches.slice(0, MAX_LIMIT).map(guideSummary) }; const guide = matches[0]; const result = { ...guideSummary(guide), content: guide.content }; if (options.includeRawXml === true) result.rawXml = guide.rawXml; return { found: true, guide: result }; }
}

export async function dispatchTool(docs, name, args = {}) {
  switch (name) {
    case "status": return docs.status(); case "refresh": return docs.refresh(); case "glob": return docs.glob(args.pattern, args.limit, args.caseSensitive); case "search": return docs.search(args); case "list_assemblies": return docs.listAssemblies(); case "list_types": return docs.listTypes(args); case "get_type": return docs.getType(args); case "list_members": return docs.listMembers(args); case "get_member": return docs.getMember(args); case "list_enums": return docs.listEnums(args); case "get_enum": return docs.getEnum(args); case "list_examples": return docs.listExamples(args); case "get_example": return docs.getExample(args); case "list_guides": return docs.listGuides(args); case "get_guide": return docs.getGuide(args); default: throw new Error(`Unknown SolidWorks documentation tool: ${name}`);
  }
}

export { globToRegExp, loadIndex, parseMember, parseSignature, textFromXml };
