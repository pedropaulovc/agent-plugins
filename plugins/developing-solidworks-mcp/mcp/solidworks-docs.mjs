import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

export const SERVER_VERSION = "0.9.9";
export const REPOSITORY = "pedropaulovc/offline-solidworks-api-docs";
export const XML_NAMESPACE = "urn:solidworks:offline-xmldoc:1";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_UNCOMPRESSED_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_UNCOMPRESSED_TOTAL_BYTES = 512 * 1024 * 1024;
const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const METADATA_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 600_000;
const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  CRC32_TABLE[index] = value >>> 0;
}
const KIND_BY_PREFIX = { T: "type", M: "method", P: "property", F: "field", E: "event" };

const TOOL_LIMIT_SCHEMA = { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT };
const SEARCH_PAGE_SIZE = 10;
const SEARCH_LIMIT_SCHEMA = { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: SEARCH_PAGE_SIZE };
const TOOL_MEMBER_LIMIT_SCHEMA = { type: "integer", minimum: 1, maximum: MAX_LIMIT };
const TOOL_OFFSET_SCHEMA = { type: "integer", minimum: 0, default: 0 };
const TOOL_MEMBER_OFFSET_SCHEMA = { type: "integer", minimum: 0 };

function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

export const TOOL_DEFINITIONS = [
  { name: "status", description: "Show the cached SolidWorks XMLDoc bundle and query the latest online release metadata. Returns the cached version, latest online version, release details, extracted files, and indexed counts.", inputSchema: objectSchema({}) },
  { name: "refresh", description: "Fetch the latest SolidWorks.Interop.xmldoc.zip release asset, replace the cache, unpack it, and rebuild the semantic index.", inputSchema: objectSchema({}) },
  { name: "glob", description: "Match virtual documentation paths with a glob pattern. Paths include types/, members/, examples/, guides/, and files/ entries; * matches across path separators, ** supports recursive path segments, and ? matches one non-/ character.", inputSchema: objectSchema({ pattern: { type: "string", minLength: 1 }, caseSensitive: { type: "boolean", default: false }, limit: TOOL_LIMIT_SCHEMA }, ["pattern"]) },
  { name: "search", description: "Search indexed assemblies, API types, members, examples, and guides. Filter with kind, query, or assembly; kind defaults to all and uses the same categories as list. Results are paginated with a default page size of 10; use offset for the next page.", inputSchema: objectSchema({ query: { type: "string", minLength: 1 }, caseSensitive: { type: "boolean", default: false }, kind: { type: "string", enum: ["all", "assembly", "type", "enum", "member", "method", "property", "field", "event", "example", "guide"], default: "all" }, assembly: { type: "string" }, limit: SEARCH_LIMIT_SCHEMA, offset: TOOL_OFFSET_SCHEMA }, ["query"]) },
  { name: "list", description: "List the indexed documentation catalog in one paginated result: assemblies, API types, enums, members, examples, and coding guides. Filter with kind, query, assembly, type, member, language, or root; use get for complete type and member information.", inputSchema: objectSchema({ kind: { type: "string", enum: ["all", "assembly", "type", "enum", "member", "method", "property", "field", "event", "example", "guide"], default: "all" }, query: { type: "string" }, type: { type: "string", minLength: 1 }, member: { type: "string" }, assembly: { type: "string" }, language: { type: "string" }, root: { type: "string" }, limit: TOOL_LIMIT_SCHEMA, offset: TOOL_OFFSET_SCHEMA }) },
  { name: "get", description: "Fetch one complete documented item. Set kind to type or enum for API types with paginated members, example for a complete code example, or guide for a complete Markdown guide.", inputSchema: objectSchema({ kind: { type: "string", enum: ["type", "enum", "example", "guide"] }, name: { type: "string", minLength: 1 }, assembly: { type: "string" }, includeMembers: { type: "boolean", default: true }, memberLimit: TOOL_MEMBER_LIMIT_SCHEMA, memberOffset: TOOL_MEMBER_OFFSET_SCHEMA, includeRawXml: { type: "boolean", default: false } }, ["kind", "name"]) },
];


function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(number)));
}
function clampOffset(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.trunc(number));
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
  const pattern = new RegExp(`<${qualifiedTag(localName)}(?=[\\s/>])(?![^>]*\\/\\s*>)([^>]*)>([\\s\\S]*?)</${qualifiedTag(localName)}\\s*>`, "gi");
  return [...String(source ?? "").matchAll(pattern)].map((match) => ({ attributes: parseAttributes(match[1]), inner: match[2], raw: match[0], index: match.index ?? 0 }));
}
function collectSelfClosingElements(source, localName) {
  const pattern = new RegExp(`<${qualifiedTag(localName)}(?=[\\s/>])([^>]*)\\/\\s*>`, "gi");
  return [...String(source ?? "").matchAll(pattern)].map((match) => ({ attributes: parseAttributes(match[1]), inner: "", raw: match[0], index: match.index ?? 0 }));
}
function firstElement(source, localName) { return collectElements(source, localName)[0] ?? null; }
function elementText(source, localName, preserveWhitespace = false) { const element = firstElement(source, localName); return element ? textFromXml(element.inner, preserveWhitespace) : null; }
function textFromXml(source, preserveWhitespace = false) {
  const cdata = [];
  let value = String(source ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, content) => {
    const token = `\u0000CDATA${cdata.length}\u0000`;
    cdata.push(content);
    return token;
  })
    .replace(/<\s*(?:see|seealso)\b([^>]*)\/\s*>/gi, (_, rawAttributes) => shortReference(parseAttributes(rawAttributes).cref ?? parseAttributes(rawAttributes).href ?? ""))
    .replace(/<\s*(?:see|seealso)\b[^>]*>([\s\S]*?)<\/\s*(?:see|seealso)\s*>/gi, "$1")
    .replace(/<\s*(?:paramref|typeparamref)\b([^>]*)\/\s*>/gi, (_, rawAttributes) => parseAttributes(rawAttributes).name ?? "")
    .replace(/<\s*(?:code|c)\b[^>]*>/gi, "")
    .replace(/<\s*\/(?:code|c)\s*>/gi, "")
    .replace(/<\s*(\/?)\s*(?:para|br|p|div|section|list|listheader|item|listitem|term|description)(?=[\s/>])[^>]*?(\/?)\s*>/gi, (_, closing, selfClosing) => closing || selfClosing ? "\n" : " ")
    .replace(/<[^>]+>/g, "");
  value = decodeXml(value).replace(/\u0000CDATA(\d+)\u0000/g, (_, index) => cdata[Number(index)] ?? "").replace(/\r\n?/g, "\n");
  if (preserveWhitespace) return value.trim();
  return value.split("\n").map((line) => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
function rawContentText(source) {
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
function memberKey(assembly, id) { return `${String(assembly ?? "").toLowerCase()}\u0000${String(id ?? "")}`; }
function companionMembers(state, cref) {
  const candidates = state.membersByXmlId.get(cref) ?? [];
  if (candidates.length <= 1) return candidates;
  const separator = String(cref).indexOf(":");
  const fullName = separator >= 0 ? String(cref).slice(separator + 1) : String(cref);
  const qualified = candidates.filter((member) => {
    const assembly = String(member.assembly ?? "");
    return member.fullName === fullName && fullName.toLowerCase().startsWith(`${assembly.toLowerCase()}.`);
  });
  return qualified;
}
function typeKey(assembly, fullName) { return memberKey(assembly, fullName); }
function parseExamples(inner, ownerId, assembly) {
  return collectElements(inner, "example").map((element, index) => {
    const source = element.attributes["sw:source"] ?? element.attributes.source ?? "";
    const id = normalizePath(source).replace(/^\//, "") || `${assembly}/${ownerId}#example-${index + 1}`;
    const contentElement = firstElement(element.inner, "content");
    return { id, title: element.attributes["sw:title"] ?? element.attributes.title ?? id, language: element.attributes["sw:language"] ?? element.attributes.language ?? "Unknown", source: source || null, content: contentElement ? rawContentText(contentElement.inner) : rawContentText(element.inner), memberIds: [ownerId], memberKeys: [memberKey(assembly, ownerId)], rawXml: element.raw, embedded: true };
  });
}
function parseEnumCode(summary) {
  const token = String(summary ?? "").trim().match(/^([+-]?(?:0x[0-9a-f]+|\d+(?:\.\d+)?))(?=\s*(?:;|=|\bor\b|$))/i)?.[1];
  if (!token) return null;
  return /^[-+]?0x/i.test(token) ? Number.parseInt(token, 16) : Number(token);
}
function parseMember(element, assembly, sourceFile) {
  const id = element.attributes.name ?? "";
  const separator = id.indexOf(":");
  const prefix = separator > 0 ? id.slice(0, separator) : "";
  const fullName = separator > 0 ? id.slice(separator + 1) : id;
  const kind = KIND_BY_PREFIX[prefix] ?? "member";
  const summary = elementText(element.inner, "summary");
  const value = elementText(element.inner, "value");
  return { id, prefix, kind, fullName, shortName: shortReference(fullName), assembly, sourceFile, summary, enumValue: parseEnumCode(summary) ?? parseEnumCode(value), remarks: elementText(element.inner, "remarks"), returns: elementText(element.inner, "returns"), value, availability: elementText(element.inner, "availability"), parameters: parseParameters(element.inner, "param"), typeParameters: parseParameters(element.inner, "typeparam"), exceptions: collectElements(element.inner, "exception").map((exception) => ({ cref: exception.attributes.cref ?? null, description: textFromXml(exception.inner) })), seeAlso: [...collectElements(element.inner, "seealso"), ...collectSelfClosingElements(element.inner, "seealso")].map((reference) => ({ cref: reference.attributes.cref ?? null, href: reference.attributes.href ?? null, text: textFromXml(reference.inner) })), signature: parseSignature(element.inner), exampleRefs: parseExampleRefs(element.inner), examples: parseExamples(element.inner, id, assembly), typeFullName: kind === "type" ? fullName : containingType(fullName), rawXml: element.raw, searchText: textFromXml(element.raw, true) };
}
function containingType(fullName) { const withoutParameters = String(fullName ?? "").split("(")[0]; const separator = withoutParameters.lastIndexOf("."); return separator > 0 ? withoutParameters.slice(0, separator) : null; }
function isTypeRecord(member) { return member.prefix === "T"; }
function parseCompanionExample(element) {
  const contentElement = firstElement(element.inner, "content");
  const id = normalizePath(element.attributes.id ?? element.attributes.source ?? "").replace(/^\//, "");
  return { id, title: element.attributes.title ?? id, language: element.attributes.language ?? "Unknown", source: element.attributes.source ?? null, content: contentElement ? rawContentText(contentElement.inner) : "", memberIds: [...collectSelfClosingElements(element.inner, "applies-to"), ...collectElements(element.inner, "applies-to")].map((reference) => reference.attributes.cref ?? "").filter(Boolean), memberKeys: [], rawXml: element.raw, embedded: false };
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
  const state = { metadata, files: [], rawFiles: new Map(), assemblies: new Map(), members: [], membersById: new Map(), membersByXmlId: new Map(), membersByTypeKey: new Map(), types: [], typesByName: new Map(), examples: [], examplesById: new Map(), guides: [], guidesById: new Map(), virtualEntries: [] };
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
      const key = memberKey(assemblyName, member.id);
      const existing = state.membersById.get(key);
      if (existing) {
        existing.exampleRefs.push(...member.exampleRefs);
        existing.examples.push(...member.examples);
        existing.exampleRefs = dedupeRefs(existing.exampleRefs);
        existing.examples = dedupeExamples(existing.examples);
        for (const example of member.examples) addExample(state, example);
        continue;
      }
      state.members.push(member);
      state.membersById.set(key, member);
      const sameId = state.membersByXmlId.get(member.id) ?? [];
      sameId.push(member);
      state.membersByXmlId.set(member.id, sameId);
      if (member.kind === "type") { state.types.push(member); state.typesByName.set(typeKey(member.assembly, member.fullName), member); }
      for (const example of member.examples) addExample(state, example);
    }
  }
  for (const member of state.members) {
    member.exampleRefs = dedupeRefs(member.exampleRefs);
    member.exampleIds = unique(member.exampleRefs.map((reference) => reference.id).concat(member.examples.map((example) => example.id)));
    for (const exampleId of member.exampleIds) {
      const example = state.examplesById.get(exampleId.toLowerCase());
      if (!example) continue;
      example.memberIds = unique(example.memberIds.concat(member.id));
      example.memberKeys = unique((example.memberKeys ?? []).concat(memberKey(member.assembly, member.id)));
    }
    if (isTypeRecord(member)) continue;
    const key = typeKey(member.assembly, member.typeFullName);
    const members = state.membersByTypeKey.get(key) ?? [];
    members.push(member);
    state.membersByTypeKey.set(key, members);
  }
  for (const example of state.examples) {
    for (const cref of example.memberIds ?? []) {
      for (const member of companionMembers(state, cref)) {
        member.exampleIds = unique((member.exampleIds ?? []).concat(example.id));
        example.memberIds = unique(example.memberIds.concat(member.id));
        example.memberKeys = unique((example.memberKeys ?? []).concat(memberKey(member.assembly, member.id)));
      }
    }
  }
  for (const type of state.types) {
    const children = state.membersByTypeKey.get(typeKey(type.assembly, type.fullName)) ?? [];
    type.memberKeys = children.map((member) => memberKey(member.assembly, member.id));
    type.memberIds = children.map((member) => member.id);
    type.memberCount = children.length;
    type.isEnum = inferEnum(type, children);
    type.kind = type.isEnum ? "enum" : "type";
    type.exampleIds = unique((type.exampleIds ?? []).concat(type.exampleRefs.map((reference) => reference.id), type.examples.map((example) => example.id)));
  }
  for (const member of state.members) {
    member.searchText = memberSearchText(member, state);
    member.searchTextLower = member.searchText.toLowerCase();
  }
  for (const type of state.types) {
    type.searchText = typeSearchText(type, state);
    type.searchTextLower = type.searchText.toLowerCase();
  }
  state.types.sort(compareName); state.members.sort(compareName); state.examples.sort(compareName); state.guides.sort(compareName); state.files.sort(); state.virtualEntries = buildVirtualEntries(state); return state;
}
function addExample(state, example) {
  const key = example.id.toLowerCase();
  const existing = state.examplesById.get(key);
  if (!existing) { state.examples.push(example); state.examplesById.set(key, example); return; }
  existing.memberIds = unique(existing.memberIds.concat(example.memberIds));
  existing.memberKeys = unique((existing.memberKeys ?? []).concat(example.memberKeys ?? []));
  if (!existing.content && example.content) existing.content = example.content;
  if (!existing.title && example.title) existing.title = example.title;
  if (existing.language === "Unknown" && example.language) existing.language = example.language;
  if (!existing.rawXml && example.rawXml) existing.rawXml = example.rawXml;
}
function dedupeRefs(refs) { const seen = new Set(); return refs.filter((reference) => { const key = `${reference.id.toLowerCase()}|${reference.language ?? ""}|${reference.source ?? ""}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function dedupeExamples(examples) { const seen = new Set(); return examples.filter((example) => { if (seen.has(example.id.toLowerCase())) return false; seen.add(example.id.toLowerCase()); return true; }); }
function inferEnum(type, members) { if (type.fullName.endsWith("_e")) return true; return members.length > 0 && members.every((member) => member.kind === "field") && type.assembly.toLowerCase().endsWith("swconst"); }
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
  let expression = "^";
  const normalized = normalizePath(pattern);
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        if (normalized[index + 2] === "/") {
          expression += "(?:.*/)?";
          index += 2;
        } else {
          expression += ".*";
          index += 1;
        }
      } else {
        expression += ".*";
      }
      continue;
    }
    if (character === "?") {
      expression += "[^/]";
      continue;
    }
    expression += /[\\^$+?.()|{}[\]]/.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${expression}$`, caseSensitive ? "" : "i");
}
function memberPath(member) { const typeName = member.typeFullName?.split(".").at(-1) ?? "global"; return `members/${member.assembly}/${typeName}/${member.shortName}`; }
function typePath(type) { return `${type.isEnum ? "enums" : "types"}/${type.assembly}/${type.shortName}`; }
function signatureDetails(signature) { return signature ? { ...signature, returnType: signature.returnType ?? null } : null; }
function exampleLinks(state, ids = [], refs = []) {
  const links = [];
  const seen = new Map();
  const add = (id, fallback = {}) => {
    const normalized = normalizePath(id).replace(/^\/+/, "");
    if (!normalized) return;
    const key = normalized.toLowerCase();
    const existing = seen.get(key);
    if (existing) {
      if (existing.title === existing.id && fallback.title) existing.title = fallback.title;
      if (existing.language == null && fallback.language != null) existing.language = fallback.language;
      if (existing.source == null && fallback.source != null) existing.source = fallback.source;
      return;
    }
    const example = state?.examplesById.get(key);
    const link = example
      ? { id: example.id, title: example.title, language: example.language, source: example.source, path: `examples/${example.id}` }
      : { id: normalized, title: fallback.title ?? normalized, language: fallback.language ?? null, source: fallback.source ?? null, path: `examples/${normalized}` };
    seen.set(key, link);
    links.push(link);
  };
  for (const id of ids) add(id);
  for (const reference of refs) add(reference.id, reference);
  return links;
}
function memberSummary(member, state) {
  const signature = signatureDetails(member.signature);
  const examples = exampleLinks(state, member.exampleIds, member.exampleRefs);
  return { id: member.id, name: member.shortName, fullName: member.fullName, kind: member.kind, assembly: member.assembly, type: member.typeFullName, description: member.summary, summary: member.summary, enumValue: member.enumValue, enumCode: member.enumValue, value: member.value, availability: member.availability, remarks: member.remarks, returns: member.returns, returnType: signature?.returnType ?? null, signature, parameters: member.parameters, typeParameters: member.typeParameters, exceptions: member.exceptions, seeAlso: member.seeAlso, examples, exampleIds: member.exampleIds ?? [], exampleRefs: member.exampleRefs, path: memberPath(member) };
}
function expandedMember(member, includeRawXml, state) {
  const result = { ...memberSummary(member, state) };
  if (includeRawXml) result.rawXml = member.rawXml;
  return result;
}
function typeSummary(type, state) {
  const signature = signatureDetails(type.signature);
  const examples = exampleLinks(state, type.exampleIds, type.exampleRefs);
  return { id: type.id, name: type.shortName, fullName: type.fullName, kind: type.kind, assembly: type.assembly, description: type.summary, summary: type.summary, remarks: type.remarks, returns: type.returns, value: type.value, availability: type.availability, returnType: signature?.returnType ?? null, signature, parameters: type.parameters, typeParameters: type.typeParameters, exceptions: type.exceptions, seeAlso: type.seeAlso, memberCount: type.memberCount ?? 0, examples, exampleIds: type.exampleIds ?? [], exampleRefs: type.exampleRefs, path: typePath(type) };
}
function exampleSummary(example) { return { id: example.id, title: example.title, language: example.language, source: example.source, members: example.memberIds, path: `examples/${example.id}` }; }
function guideSummary(guide) { return { id: guide.id, title: guide.title, source: guide.source, root: guide.root, format: guide.format, path: `guides/${guide.id}` }; }
function listCatalog(state, options = {}) {
  const kind = options.kind ?? "all";
  const query = options.query?.trim() ?? "";
  const memberKinds = new Set(["method", "property", "field", "event"]);
  const scopedKind = options.type ? "member" : options.member ? "example" : options.root ? "guide" : null;
  const memberTypeKeys = options.type
    ? new Set(resolveType(state, options.type, options.assembly).map((type) => typeKey(type.assembly, type.fullName)))
    : null;
  const items = [];
  const include = (itemKind) => !scopedKind && (kind === "all" || kind === itemKind);
  const includeMembers = (!scopedKind || scopedKind === "member") && (kind === "all" || kind === "member" || memberKinds.has(kind));
  const matchesQuery = (value) => !query || matchesText(value, query);
  const assemblySummary = (assembly) => {
    const members = state.members.filter((member) => member.assembly === assembly.name && !isTypeRecord(member)).length;
    return { kind: "assembly", id: assembly.name, name: assembly.name, assembly: assembly.name, sourceFiles: assembly.sourceFiles, types: state.types.filter((type) => type.assembly === assembly.name).length, members, path: `assemblies/${assembly.name}` };
  };

  if (include("assembly")) for (const assembly of state.assemblies.values()) {
    const item = assemblySummary(assembly);
    if (options.assembly && !matchesAssembly(assembly.name, options.assembly)) continue;
    if (matchesQuery(`${item.name} ${item.sourceFiles.join(" ")}`)) items.push(item);
  }
  for (const type of state.types) {
    const itemKind = type.isEnum ? "enum" : "type";
    if (!include(itemKind)) continue;
    if (!matchesAssembly(type.assembly, options.assembly)) continue;
    if (options.language) continue;
    if (matchesQuery(`${type.fullName} ${type.shortName} ${type.summary}`)) items.push({ ...typeSummary(type, state), kind: itemKind });
  }
  if (includeMembers) for (const member of state.members) {
    if (isTypeRecord(member)) continue;
    if (!matchesAssembly(member.assembly, options.assembly)) continue;
    if (memberTypeKeys && !memberTypeKeys.has(typeKey(member.assembly, member.typeFullName))) continue;
    if (memberKinds.has(kind) && member.kind !== kind) continue;
    if (matchesQuery(memberSearchText(member, state))) items.push(memberSummary(member, state));
  }
  if (include("example")) for (const example of state.examples) {
    if (options.assembly && !exampleMatchesAssembly(state, example, options.assembly)) continue;
    if (options.language && !matchesText(example.language, options.language)) continue;
    if (options.member && !example.memberIds.some((id) => matchesText(id, options.member))) continue;
    if (matchesQuery(exampleSearchText(example))) items.push({ kind: "example", ...exampleSummary(example) });
  }
  if (include("guide")) for (const guide of state.guides) {
    if (options.assembly || options.language) continue;
    if (options.root && guide.root?.toLowerCase() !== options.root.toLowerCase()) continue;
    if (matchesQuery(guideSearchText(guide))) items.push({ kind: "guide", ...guideSummary(guide) });
  }

  const order = { assembly: 0, type: 1, enum: 2, method: 3, property: 3, field: 3, event: 3, member: 3, example: 4, guide: 5 };
  items.sort((left, right) => (order[left.kind] ?? 3) - (order[right.kind] ?? 3) || left.path.localeCompare(right.path));
  const offset = clampOffset(options.offset);
  const limit = clampLimit(options.limit);
  const page = items.slice(offset, offset + limit);
  const truncated = offset + page.length < items.length;
  return { kind, query, type: options.type ?? null, member: options.member ?? null, assembly: options.assembly ?? null, language: options.language ?? null, root: options.root ?? null, count: page.length, total: items.length, offset, limit, truncated, nextOffset: truncated ? offset + page.length : null, items: page };
}
function firstLines(value, limit = 50) {
  const lines = String(value ?? "").split(/\r?\n/);
  return { content: lines.slice(0, limit).join("\n"), contentLineCount: Math.min(lines.length, limit), totalLineCount: lines.length, contentTruncated: lines.length > limit };
}
function searchResultDetails(state, record, description = record.summary) {
  const signature = signatureDetails(record.signature);
  const examples = exampleLinks(state, record.exampleIds, record.exampleRefs);
  return { description: description ?? null, summary: record.summary ?? null, type: record.typeFullName ?? null, enumValue: record.enumValue ?? null, enumCode: record.enumValue ?? null, value: record.value ?? null, availability: record.availability ?? null, signature, returnType: signature?.returnType ?? null, parameters: record.parameters ?? [], typeParameters: record.typeParameters ?? [], exceptions: record.exceptions ?? [], seeAlso: record.seeAlso ?? [], remarks: record.remarks ?? null, returns: record.returns ?? null, memberCount: record.memberCount ?? null, examples, exampleIds: record.exampleIds ?? [], exampleRefs: record.exampleRefs ?? [] };
}
function matchesText(value, query, caseSensitive = false) { const left = String(value ?? ""); const right = String(query ?? ""); return caseSensitive ? left.includes(right) : left.toLowerCase().includes(right.toLowerCase()); }
function matchesAssembly(value, assembly, caseSensitive = false) { return !assembly || (caseSensitive ? String(value ?? "") === String(assembly) : String(value ?? "").toLowerCase() === String(assembly).toLowerCase()); }
function snippet(text, query, radius = 180, caseSensitive = false) { const source = String(text ?? "").replace(/\s+/g, " ").trim(); const haystack = caseSensitive ? source : source.toLowerCase(); const needle = caseSensitive ? String(query) : String(query).toLowerCase(); const index = haystack.indexOf(needle); if (index < 0) return source.slice(0, radius * 2); const start = Math.max(0, index - radius); const end = Math.min(source.length, index + String(query).length + radius); return `${start > 0 ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`; }
function searchText(values) { return values.flat(Infinity).filter((value) => value !== null && value !== undefined && typeof value !== "object").join(" "); }
function linkedExamples(state, ids = []) { return ids.map((id) => state.examplesById.get(String(id).toLowerCase())).filter(Boolean); }
function exampleMatchesAssembly(state, example, assembly, caseSensitive = false) {
  if (!assembly) return true;
  if (example.memberKeys?.length) return example.memberKeys.some((key) => {
    const member = state.membersById.get(key);
    return member && matchesAssembly(member.assembly, assembly, caseSensitive);
  });
  return example.memberIds.some((memberId) => (state.membersByXmlId.get(memberId) ?? []).some((member) => matchesAssembly(member.assembly, assembly, caseSensitive)));
}
function exampleSearchText(example) { return searchText([example.id, example.title, example.language, example.source, example.memberIds, example.memberKeys, example.content, example.rawXml]); }
function guideSearchText(guide) { return searchText([guide.id, guide.title, guide.source, guide.root, guide.format, guide.content, guide.rawXml]); }
function memberSearchText(member, state) {
  const signature = member.signature ?? {};
  const signatureParameters = (signature.parameters ?? []).flatMap((parameter) => [parameter.name, parameter.type, parameter.direction]);
  const documentationParameters = [...(member.parameters ?? []), ...(member.typeParameters ?? [])].flatMap((parameter) => [parameter.name, parameter.description]);
  const references = [...(member.exampleRefs ?? []).flatMap((reference) => [reference.id, reference.language, reference.source]), ...(member.seeAlso ?? []).flatMap((reference) => [reference.cref, reference.href, reference.text]), ...(member.exceptions ?? []).flatMap((exception) => [exception.cref, exception.description])];
  const examples = [...(member.examples ?? []), ...linkedExamples(state, member.exampleIds)].flatMap((example) => [example.id, example.title, example.language, example.source, example.content, example.rawXml]);
  return searchText([member.searchText, member.id, member.prefix, member.fullName, member.shortName, member.assembly, member.sourceFile, member.typeFullName, member.kind, member.summary, member.remarks, member.returns, member.value, member.availability, member.enumValue, signature.kind, signature.display, signature.returnType, signatureParameters, documentationParameters, references, examples]);
}
function typeSearchText(type, state) {
  const signature = type.signature ?? {};
  const examples = linkedExamples(state, type.exampleIds).flatMap((example) => [example.id, example.title, example.language, example.source, example.content, example.rawXml]);
  const references = [...(type.exampleRefs ?? []).flatMap((reference) => [reference.id, reference.language, reference.source]), ...(type.seeAlso ?? []).flatMap((reference) => [reference.cref, reference.href, reference.text])];
  return searchText([type.searchText, type.id, type.fullName, type.shortName, type.assembly, type.sourceFile, type.kind, type.isEnum, type.memberIds, type.memberKeys, type.summary, type.remarks, type.returns, type.value, type.availability, signature.kind, signature.display, signature.returnType, references, examples]);
}
function resolveType(state, name, assembly) {
  let rawQuery = normalizePath(String(name ?? "").trim()).replace(/^(?:types|enums)\//i, "").replace(/\/_overview\.md$/i, "").replace(/\.md$/i, "").replace(/^T:/i, "");
  const segments = rawQuery.split("/").filter(Boolean);
  let requestedAssembly = assembly;
  if (segments.length > 1 && (!assembly || matchesAssembly(segments[0], assembly))) {
    const consumed = segments.shift();
    requestedAssembly ??= consumed;
  }
  const query = segments.join(".") || rawQuery;
  const candidates = state.types.filter((type) => matchesAssembly(type.assembly, requestedAssembly));
  const exact = candidates.filter((type) => [type.fullName, type.id.slice(2)].some((value) => value.toLowerCase() === query.toLowerCase()));
  if (exact.length) return exact;
  const short = candidates.filter((type) => type.shortName.toLowerCase() === query.toLowerCase());
  if (short.length) return short;
  return candidates.filter((type) => matchesText(type.fullName, query) || matchesText(type.shortName, query));
}
function resolveExample(state, name) { const query = normalizePath(String(name ?? "").trim()).replace(/^examples\//i, ""); const exact = state.examples.filter((example) => [example.id, normalizePath(example.source ?? "")].some((value) => value.toLowerCase() === query.toLowerCase())); if (exact.length) return exact; return state.examples.filter((example) => matchesText(example.id, query) || matchesText(example.title, query)); }
function resolveGuide(state, name) { const query = normalizePath(String(name ?? "").trim()).replace(/^guides\//i, ""); const exact = state.guides.filter((guide) => [guide.id, normalizePath(guide.source ?? "")].some((value) => value.toLowerCase() === query.toLowerCase())); if (exact.length) return exact; return state.guides.filter((guide) => matchesText(guide.id, query) || matchesText(guide.title, query)); }
function expandedType(state, type, options = {}) {
  const result = { ...typeSummary(type, state), remarks: type.remarks, returns: type.returns, value: type.value, availability: type.availability, parameters: type.parameters, typeParameters: type.typeParameters, exceptions: type.exceptions, seeAlso: type.seeAlso, exampleRefs: type.exampleRefs };
  if (options.includeRawXml === true) result.rawXml = type.rawXml;
  if (options.includeMembers === false) return result;
  const allMembers = (type.memberKeys ?? []).map((key) => state.membersById.get(key)).filter(Boolean);
  const paginated = options.memberLimit !== undefined || options.memberOffset !== undefined;
  const offset = clampOffset(options.memberOffset);
  const limit = paginated ? clampLimit(options.memberLimit, MAX_LIMIT) : allMembers.length;
  const members = paginated ? allMembers.slice(offset, offset + limit) : allMembers.slice(offset);
  result.members = members.map((member) => expandedMember(member, false, state));
  result.memberOffset = offset;
  result.memberLimit = limit;
  result.membersTotal = allMembers.length;
  result.membersTruncated = offset + members.length < allMembers.length;
  return result;
}
function searchState(state, options = {}) {
  const query = String(options.query ?? "").trim();
  const kind = options.kind ?? "all";
  const limit = clampLimit(options.limit, SEARCH_PAGE_SIZE);
  const offset = clampOffset(options.offset);
  const caseSensitive = options.caseSensitive === true;
  const memberKinds = new Set(["method", "property", "field", "event"]);
  const matches = [];
  const include = (itemKind) => kind === "all" || kind === itemKind;
  const includeMembers = kind === "all" || kind === "member" || memberKinds.has(kind);
  const add = (itemKind, label, buildText, path, extra = {}) => {
    const searchable = typeof buildText === "function" ? buildText() : buildText;
    const text = typeof searchable === "object" ? searchable.text : searchable;
    const lowerText = typeof searchable === "object" ? searchable.lower : text.toLowerCase();
    if (!(caseSensitive ? text : lowerText).includes(caseSensitive ? query : query.toLowerCase())) return;
    const resolvedExtra = typeof extra === "function" ? extra() : extra;
    matches.push({ kind: itemKind, label, path, snippet: snippet(text, query, 180, caseSensitive), ...resolvedExtra });
  };
  if (include("assembly")) for (const assembly of state.assemblies.values()) {
    const summary = {
      id: assembly.name,
      name: assembly.name,
      assembly: assembly.name,
      sourceFiles: assembly.sourceFiles,
      types: state.types.filter((type) => type.assembly === assembly.name).length,
      members: state.members.filter((member) => member.assembly === assembly.name && !isTypeRecord(member)).length,
    };
    if (!matchesAssembly(assembly.name, options.assembly, caseSensitive)) continue;
    add("assembly", assembly.name, () => `${assembly.name} ${assembly.sourceFiles.join(" ")}`, `assemblies/${assembly.name}`, summary);
  }
  for (const type of state.types) {
    const itemKind = type.isEnum ? "enum" : "type";
    if (!include(itemKind)) continue;
    if (!matchesAssembly(type.assembly, options.assembly, caseSensitive)) continue;
    add(itemKind, type.fullName, { text: type.searchText, lower: type.searchTextLower }, typePath(type), { id: type.id, assembly: type.assembly, ...searchResultDetails(state, type) });
  }
  if (includeMembers) for (const member of state.members) {
    if (isTypeRecord(member)) continue;
    if (!matchesAssembly(member.assembly, options.assembly, caseSensitive)) continue;
    if (memberKinds.has(kind) && member.kind !== kind) continue;
    add(member.kind, member.fullName, { text: member.searchText, lower: member.searchTextLower }, memberPath(member), { id: member.id, assembly: member.assembly, type: member.typeFullName, ...searchResultDetails(state, member) });
  }
  if (include("example")) for (const example of state.examples) {
    if (!exampleMatchesAssembly(state, example, options.assembly, caseSensitive)) continue;
    add("example", example.title, () => exampleSearchText(example), `examples/${example.id}`, () => {
      const preview = firstLines(example.content);
      return { id: example.id, language: example.language, members: example.memberIds, ...searchResultDetails(state, example, example.title), ...preview };
    });
  }
  if (include("guide")) for (const guide of state.guides) {
    if (options.assembly) continue;
    add("guide", guide.title, () => guideSearchText(guide), `guides/${guide.id}`, { id: guide.id, root: guide.root, ...searchResultDetails(state, guide, guide.title) });
  }
  const results = matches.slice(offset, offset + limit);
  const truncated = offset + results.length < matches.length;
  return { query, kind, caseSensitive, count: results.length, total: matches.length, offset, limit, truncated, nextOffset: truncated ? offset + results.length : null, results };
}
function statusFromState(state) {
  const assemblies = [...state.assemblies.values()].map((assembly) => ({ name: assembly.name, sourceFiles: assembly.sourceFiles, types: state.types.filter((type) => type.assembly === assembly.name).length, members: state.members.filter((member) => member.assembly === assembly.name && !isTypeRecord(member)).length }));
  return { ...state.metadata, bundleVersion: state.metadata.bundleVersion ?? state.metadata.tag ?? "unknown", extractedFiles: state.files, counts: { assemblies: assemblies.length, types: state.types.length, enums: state.types.filter((type) => type.isEnum).length, members: state.members.filter((member) => !isTypeRecord(member)).length, examples: state.examples.length, guides: state.guides.length }, assemblies };
}
function onlineReleaseSummary({ release, asset, tag }) {
  return {
    bundleVersion: tag,
    tag,
    releaseUrl: release.html_url ?? null,
    assetName: asset.name,
    assetUrl: asset.browser_download_url ?? null,
    digest: parseDigest(asset.digest) || null,
  };
}
function safeCacheRoot(env = process.env) { if (env.SOLIDWORKS_DOCS_CACHE_DIR) return resolve(env.SOLIDWORKS_DOCS_CACHE_DIR); if (env.CLAUDE_PLUGIN_DATA) return join(resolve(env.CLAUDE_PLUGIN_DATA), "solidworks-docs"); if (env.XDG_CACHE_HOME) return join(resolve(env.XDG_CACHE_HOME), "developing-solidworks"); if (process.platform === "win32" && env.LOCALAPPDATA) return join(resolve(env.LOCALAPPDATA), "developing-solidworks"); return join(homedir(), ".cache", "developing-solidworks"); }
async function pathExists(path) { try { await fs.access(path); return true; } catch { return false; } }
async function readJson(path) { try { return JSON.parse(await fs.readFile(path, "utf8")); } catch { return null; } }
function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
function parseDigest(value) { return String(value ?? "").replace(/^sha256:/i, "").toLowerCase(); }
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
const CACHE_LOCK_RETRY_MS = 50;
const CACHE_LOCK_TIMEOUT_MS = METADATA_TIMEOUT_MS + DOWNLOAD_TIMEOUT_MS + 120_000;
const CACHE_LOCK_STALE_MS = CACHE_LOCK_TIMEOUT_MS + 120_000;
const CACHE_STAGING_STALE_MS = CACHE_LOCK_STALE_MS;
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
async function cleanupReleaseDirectories(cacheDir, keepDir, prefix = "release-") {
  const extractedRoot = join(cacheDir, "extracted");
  let entries;
  try {
    entries = await fs.readdir(extractedRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const keepPath = resolve(keepDir);
  const now = Date.now();
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map(async (entry) => {
      const entryPath = join(extractedRoot, entry.name);
      if (resolve(entryPath) === keepPath) return;
      if (entry.name.includes(".tmp-")) {
        let stats;
        try {
          stats = await fs.stat(entryPath);
        } catch {
          return;
        }
        if (now - stats.mtimeMs <= CACHE_STAGING_STALE_MS) return;
      }
      await fs.rm(entryPath, { recursive: true, force: true });
    }));
}
function releaseCacheDirectory(cacheDir, tag, digest) {
  const safeTag = String(tag ?? "latest").replace(/[^A-Za-z0-9._-]/g, "_");
  return join(cacheDir, "extracted", `release-${safeTag}-${digest.slice(0, 16)}`);
}
export function selectReleaseAsset(assets = []) { const zipAssets = assets.filter((asset) => /\.zip$/i.test(asset.name ?? "") && /xmldoc/i.test(asset.name ?? "")); if (!zipAssets.length) return null; const rank = (name) => /^offline-solidworks-docs\.xmldoc\.zip$/i.test(name) ? 0 : /^SolidWorks\.Interop\.xmldoc\.v?[\w.-]+\.zip$/i.test(name) ? 1 : /SolidWorks\.Interop\.xmldoc/i.test(name) ? 2 : 3; return [...zipAssets].sort((left, right) => rank(left.name) - rank(right.name) || left.name.localeCompare(right.name))[0]; }
async function fetchJson(url, fetchImpl) { const response = await fetchImpl(url, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS), headers: { Accept: "application/vnd.github+json", "User-Agent": "developing-solidworks-mcp" } }); if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`); return response.json(); }
async function downloadBuffer(url, fetchImpl) { const response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), headers: { Accept: "application/zip", "User-Agent": "developing-solidworks-mcp" } }); if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${url}`); return Buffer.from(await response.arrayBuffer()); }
function findEndOfCentralDirectory(buffer) { const minimum = Math.max(0, buffer.length - 65_557); for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) if (buffer.readUInt32LE(offset) === 0x06054b50) return offset; throw new Error("Invalid ZIP: end-of-central-directory record not found"); }
export async function unpackZip(buffer, targetDir) {
  const end = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(end + 10);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (entryCount === 0xffff || centralOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported by the bundled extractor");
  await fs.mkdir(targetDir, { recursive: true });
  let offset = centralOffset;
  let totalBytes = 0;
  const root = resolve(targetDir);
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP central-directory entry");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > buffer.length) throw new Error("Invalid ZIP central-directory entry");
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength).replaceAll("\\", "/");
    offset = entryEnd;
    if (name.startsWith("/") || name.split("/").includes("..")) throw new Error(`Unsafe ZIP entry path: ${name}`);
    if (name.endsWith("/")) continue;
    if ((flags & 0x1) !== 0) throw new Error(`Encrypted ZIP entry is not supported: ${name}`);
    if (uncompressedSize > MAX_UNCOMPRESSED_ENTRY_BYTES || totalBytes + uncompressedSize > MAX_UNCOMPRESSED_TOTAL_BYTES) throw new Error(`ZIP entry exceeds the safe extraction limit: ${name}`);
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Invalid ZIP local header: ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart > buffer.length || compressedSize > buffer.length - dataStart) throw new Error(`Invalid ZIP entry data: ${name}`);
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let content;
    if (method === 0) content = compressed;
    else if (method === 8) content = inflateRawSync(compressed, { maxOutputLength: Math.max(1, Math.min(uncompressedSize, MAX_UNCOMPRESSED_ENTRY_BYTES, MAX_UNCOMPRESSED_TOTAL_BYTES - totalBytes)) });
    else throw new Error(`Unsupported ZIP compression method ${method}: ${name}`);
    if (content.length !== uncompressedSize) throw new Error(`ZIP size mismatch: ${name}`);
    if (crc32(content) !== expectedCrc) throw new Error(`ZIP CRC mismatch: ${name}`);
    totalBytes += content.length;
    const outputPath = resolve(targetDir, name);
    if (outputPath !== root && !outputPath.startsWith(`${root}/`) && !outputPath.startsWith(`${root}\\`)) throw new Error(`Unsafe ZIP output path: ${name}`);
    await fs.mkdir(dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, content);
  }
}

export class SolidWorksDocs {
  constructor(options = {}) { this.env = options.env ?? process.env; this.fetchImpl = options.fetchImpl ?? globalThis.fetch; this.cacheDir = resolve(options.cacheDir ?? safeCacheRoot(this.env)); this.bundlePath = options.bundlePath ?? this.env.SOLIDWORKS_DOCS_BUNDLE ?? null; this.releaseApi = options.releaseApi ?? RELEASE_API; this.state = null; this.bundleMetadata = null; this.lastRelease = null; }
  async ensure(force = false) {
    if (!force && this.state && this.bundleMetadata) return this.state;
    return withCacheLock(this.cacheDir, async () => {
      const metadata = force || !this.bundleMetadata || !this.state ? await this.ensureBundle(force) : this.bundleMetadata;
      this.bundleMetadata = metadata;
      if (!this.state || this.state.metadata.digest !== metadata.digest || this.state.metadata.extractedDir !== metadata.extractedDir) this.state = await loadIndex(metadata.extractedDir, metadata);
      return this.state;
    });
  }
  async fetchLatestRelease() {
    const release = await fetchJson(this.releaseApi, this.fetchImpl);
    const asset = selectReleaseAsset(release.assets);
    if (!asset) throw new Error("The latest SolidWorks release has no xmldoc ZIP asset");
    return { release, asset, tag: release.tag_name ?? "latest" };
  }
  async ensureBundle(force = false) {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const metadataPath = join(this.cacheDir, "bundle.json");
    const existing = await readJson(metadataPath);
    const localPath = this.bundlePath ?? this.env.SOLIDWORKS_DOCS_BUNDLE;
    if (localPath) {
      this.lastRelease = null;
      const sourcePath = resolve(localPath);
      const buffer = await fs.readFile(sourcePath);
      const digest = sha256(buffer);
      const extractedDir = join(this.cacheDir, "extracted", `local-${digest.slice(0, 16)}`);
      if (!force && existing?.source === "local" && existing.digest === digest && await pathExists(extractedDir)) return existing;
      return this.replaceBundle({ buffer, metadata: { source: "local", sourcePath, repository: REPOSITORY, tag: "local", bundleVersion: this.env.SOLIDWORKS_DOCS_BUNDLE_VERSION ?? "local", assetName: basename(sourcePath), assetUrl: null, digest }, extractedDir, metadataPath });
    }
    let releaseInfo;
    try {
      releaseInfo = await this.fetchLatestRelease();
    } catch (error) {
      if (!force && existing?.extractedDir && await pathExists(existing.extractedDir)) return existing;
      throw new Error(`Unable to fetch SolidWorks XMLDoc release metadata: ${error.message}`);
    }
    this.lastRelease = releaseInfo;
    const { release, asset, tag } = releaseInfo;
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
    return this.replaceBundle({ buffer, metadata: { source: "release", sourcePath: null, repository: REPOSITORY, tag, bundleVersion: tag, assetName: asset.name, assetUrl: asset.browser_download_url, digest: actualDigest, releaseUrl: release.html_url ?? null }, extractedDir, metadataPath });
  }
  async replaceBundle({ buffer, metadata, extractedDir, metadataPath }) {
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const temporaryDir = `${extractedDir}.tmp-${suffix}`;
    await fs.rm(temporaryDir, { recursive: true, force: true });
    await fs.mkdir(temporaryDir, { recursive: true });
    try {
      await unpackZip(buffer, temporaryDir);
      const stagedMetadata = { ...metadata, extractedDir: temporaryDir };
      const stagedState = await loadIndex(temporaryDir, stagedMetadata);
      if (!stagedState.types.some((type) => type.fullName?.trim() && type.assembly?.trim())) throw new Error("SolidWorks XMLDoc bundle contains no indexed API types");
      await fs.rm(extractedDir, { recursive: true, force: true });
      await fs.rename(temporaryDir, extractedDir);
      const completeMetadata = { ...metadata, extractedDir, cachedAt: new Date().toISOString() };
      const temporaryMetadata = `${metadataPath}.tmp-${suffix}`;
      await fs.writeFile(temporaryMetadata, JSON.stringify(completeMetadata, null, 2));
      await fs.rename(temporaryMetadata, metadataPath);
      await cleanupReleaseDirectories(this.cacheDir, extractedDir, metadata.source === "release" ? "release-" : "local-");
      return completeMetadata;
    } catch (error) {
      await fs.rm(temporaryDir, { recursive: true, force: true });
      throw error;
    }
  }
  async status() {
    const hadUsableState = Boolean(this.state && this.bundleMetadata);
    const state = await this.ensure(false);
    const cached = statusFromState(state);
    const response = { ...cached, latestOnline: null, latestOnlineError: null, updateAvailable: null };
    if (state.metadata.source !== "release") return response;
    let releaseInfo = hadUsableState ? null : this.lastRelease;
    try {
      releaseInfo ??= await this.fetchLatestRelease();
    } catch (error) {
      return { ...response, latestOnlineError: error.message };
    }
    const latestOnline = onlineReleaseSummary(releaseInfo);
    return { ...response, latestOnline, updateAvailable: latestOnline.bundleVersion !== cached.bundleVersion };
  }
  async refresh() {
    this.state = null;
    this.bundleMetadata = null;
    this.lastRelease = null;
    const state = await this.ensure(true);
    const cached = statusFromState(state);
    const latestOnline = state.metadata.source === "release" && this.lastRelease ? onlineReleaseSummary(this.lastRelease) : null;
    return { ...cached, latestOnline, latestOnlineError: null, updateAvailable: latestOnline ? latestOnline.bundleVersion !== cached.bundleVersion : null };
  }
  async glob(pattern, limit, caseSensitive = false) { const state = await this.ensure(false); const regex = globToRegExp(pattern, caseSensitive); const matches = state.virtualEntries.flatMap((entry) => { const matchedPath = [entry.path, ...(entry.aliases ?? [])].find((path) => regex.test(path)); if (!matchedPath) return []; const { aliases: _aliases, ...result } = entry; return [{ ...result, matchedPath }]; }).slice(0, clampLimit(limit)); return { pattern: normalizePath(pattern), caseSensitive, count: matches.length, matches }; }
  async search(options) { return searchState(await this.ensure(false), options); }
  async list(options = {}) { return listCatalog(await this.ensure(false), options); }
  async get(options = {}) {
    const state = await this.ensure(false);
    const kind = options.kind;
    if (kind === "type" || kind === "enum") {
      const matches = resolveType(state, options.name, options.assembly);
      if (matches.length !== 1) return { found: false, matchCount: matches.length, matches: matches.slice(0, MAX_LIMIT).map((type) => typeSummary(type, state)) };
      if (matches[0].kind !== kind) return { found: false, matchCount: 0, matches: [] };
      const typeOptions = kind === "enum" ? { ...options, includeMembers: true } : options;
      return { found: true, type: expandedType(state, matches[0], typeOptions) };
    }
    if (kind === "example") {
      const matches = resolveExample(state, options.name);
      if (matches.length !== 1) return { found: false, matchCount: matches.length, matches: matches.slice(0, MAX_LIMIT).map(exampleSummary) };
      const example = matches[0];
      const result = { ...exampleSummary(example), content: example.content };
      if (options.includeRawXml === true) result.rawXml = example.rawXml;
      return { found: true, example: result };
    }
    if (kind === "guide") {
      const matches = resolveGuide(state, options.name);
      if (matches.length !== 1) return { found: false, matchCount: matches.length, matches: matches.slice(0, MAX_LIMIT).map(guideSummary) };
      const guide = matches[0];
      const result = { ...guideSummary(guide), content: guide.content };
      if (options.includeRawXml === true) result.rawXml = guide.rawXml;
      return { found: true, guide: result };
    }
    throw new Error(`Unsupported get kind: ${kind}`);
  }
}

export async function dispatchTool(docs, name, args = {}) {
  switch (name) {
    case "status": return docs.status();
    case "refresh": return docs.refresh();
    case "glob": return docs.glob(args.pattern, args.limit, args.caseSensitive);
    case "search": return docs.search(args);
    case "list": return docs.list(args);
    case "get": return docs.get(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export { globToRegExp, loadIndex, parseMember, parseSignature, textFromXml };
