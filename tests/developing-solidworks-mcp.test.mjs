import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  SERVER_VERSION,
  SolidWorksDocs,
  TOOL_DEFINITIONS,
  dispatchTool,
  selectReleaseAsset,
  unpackZip,
  textFromXml,
} from "../plugins/developing-solidworks/mcp/solidworks-docs.mjs";
import { reclaimStaleInstallLock } from "../plugins/developing-solidworks/mcp/solidworks-docs-launcher.mjs";
import { SERVER_INSTRUCTIONS } from "../plugins/developing-solidworks/mcp/solidworks-docs-mcp.mjs";

const XML_NAMESPACE = "urn:solidworks:offline-xmldoc:1";
const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  CRC32_TABLE[index] = value >>> 0;
}
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, value, method = 0] of entries) {
    const nameBuffer = Buffer.from(name);
    const content = Buffer.from(value);
    const data = method === 8 ? deflateRawSync(content) : content;
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(Buffer.concat([local, nameBuffer, data]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([central, nameBuffer]));
    offset += local.length + nameBuffer.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function fixtureEntries(label = "") {
  const memberXml = `<doc xmlns:sw="${XML_NAMESPACE}"><assembly><name>Demo</name></assembly><members>
<member name="T:Demo.Widget"><summary>A Widget type ${label}; List&lt;Widget&gt; and x &lt; 5.</summary><sw:signature kind="type" display="class Widget" /></member>
<member name="M:Demo.Widget.DoThing(System.Int32@)"><summary>Does a thing.</summary><param name="value">The input &lt;value&gt;.</param><returns>The result.</returns><seealso cref="T:Demo.Widget" /><seealso cref="T:Demo.Other">Other reference</seealso><sw:signature kind="method" display="int DoThing(ref int value)" return-type="System.Int32"><sw:parameter name="value" type="System.Int32@" direction="byref" /></sw:signature><sw:example-ref id="Examples/DoThing.htm" language="C#" source="/Examples/DoThing.htm" /></member>
<member name="T:Demo.Options_e"><summary>Options.</summary></member>
<member name="F:Demo.Options_e.OptionA"><summary>3; a documented value</summary></member>
</members></doc>`;
  const examplesXml = `<doc xmlns:sw="${XML_NAMESPACE}"><assembly><name>SolidWorks.Interop.examples</name></assembly><members /><sw:examples><sw:example id="Examples/DoThing.htm" title="Do Thing" language="C#" source="/Examples/DoThing.htm"><sw:applies-to cref="M:Demo.Widget.DoThing(System.Int32@)" /><sw:content format="solidworks-example"><![CDATA[<code>var result = widget.DoThing(ref value);</code>]]></sw:content></sw:example></sw:examples></doc>`;
  const guidesXml = `<doc xmlns:sw="${XML_NAMESPACE}"><assembly><name>SolidWorks.Interop.guides</name></assembly><members /><sw:guides><sw:guide id="root1/Guide.md" title="Guide" source="Guide.md" root="root1"><sw:content format="markdown"><![CDATA[# Guide\n\nLiteral <tag> content.]]></sw:content></sw:guide></sw:guides></doc>`;
  return [
    ["Demo.xml", memberXml],
    ["SolidWorks.Interop.examples.xml", examplesXml],
    ["SolidWorks.Interop.guides.xml", guidesXml],
  ];
}

function qualifiedFixtureEntries() {
  const assemblyXml = (assembly, marker) => `<doc xmlns:sw="${XML_NAMESPACE}"><assembly><name>${assembly}</name></assembly><members>
<member name="T:${assembly}.Widget"><summary>${marker} widget</summary><sw:signature kind="type" display="class Widget" /></member>
<member name="M:${assembly}.Widget.DoThing"><summary>${marker} shared example</summary></member>
</members></doc>`;
  const examplesXml = `<doc xmlns:sw="${XML_NAMESPACE}"><assembly><name>SolidWorks.Interop.examples</name></assembly><members /><sw:examples>
<sw:example id="Examples/A.htm" title="Shared A" language="C#" source="/Examples/A.htm"><sw:applies-to cref="M:Assembly.A.Widget.DoThing" /><sw:content format="solidworks-example"><![CDATA[Shared marker]]></sw:content></sw:example>
<sw:example id="Examples/B.htm" title="Shared B" language="C#" source="/Examples/B.htm"><sw:applies-to cref="M:Assembly.B.Widget.DoThing" /><sw:content format="solidworks-example"><![CDATA[Shared marker]]></sw:content></sw:example>
</sw:examples></doc>`;
  return [
    ["Assembly.A.xml", assemblyXml("Assembly.A", "A")],
    ["Assembly.B.xml", assemblyXml("Assembly.B", "B")],
    ["SolidWorks.Interop.examples.xml", examplesXml],
  ];
}

function duplicateAssemblyFixtureEntries() {
  const assemblyXml = (assembly, marker) => `<doc xmlns:sw="${XML_NAMESPACE}"><assembly><name>${assembly}</name></assembly><members>
<member name="T:Shared.Widget"><summary>${marker} widget</summary><sw:signature kind="type" display="class Widget" /></member>
<member name="M:Shared.Widget.DoThing"><summary>${marker} method</summary><sw:signature kind="method" display="void DoThing()" /><sw:example sw:language="C#" sw:title="${marker} embedded">${marker} embedded content</sw:example></member>
</members></doc>`;
  const duplicateMemberXml = `<doc xmlns:sw="${XML_NAMESPACE}"><assembly><name>Assembly.A</name></assembly><members>
<member name="M:Shared.Widget.DoThing"><sw:example sw:language="C#" sw:source="/Examples/Embedded.htm" sw:title="Embedded">Intro <code><![CDATA[embedded <tag> example]]></code> outro</sw:example></member>
</members></doc>`;
  return [
    ["Assembly.A.xml", assemblyXml("Assembly.A", "A")],
    ["Assembly.B.xml", assemblyXml("Assembly.B", "B")],
    ["Assembly.A.duplicate.xml", duplicateMemberXml],
  ];
}
function paginationFixtureEntries() {
  const members = Array.from({ length: 12 }, (_, index) => `<member name="F:Page.Widget.Field${index + 1}"><summary>Field ${index + 1}</summary></member>`).join("");
  return [["Page.xml", `<doc xmlns:sw="${XML_NAMESPACE}"><assembly><name>Page</name></assembly><members><member name="T:Page.Widget"><summary>Page widget</summary></member>${members}</members></doc>`]];
}
function proactiveFixtureEntries() {
  const content = Array.from({ length: 55 }, (_, index) => `line-${index + 1}`).join("\n");
  const memberXml = `<doc xmlns:sw="${XML_NAMESPACE}"><assembly><name>Proactive</name></assembly><members>
<member name="T:Proactive.Widget"><summary>Widget summary</summary><remarks>Widget remarks</remarks><sw:signature kind="type" display="class Widget" /></member>
<member name="M:Proactive.Widget.DoThing(System.String)"><summary>Method summary</summary><remarks>needle-remarks</remarks><returns>needle-returns</returns><availability>needle-availability</availability><param name="value">needle-parameter</param><typeparam name="T">needle-type-parameter</typeparam><exception cref="System.Exception">needle-exception</exception><seealso cref="T:Proactive.Other" href="https://example.test">needle-seealso</seealso><sw:signature kind="method" display="string DoThing(string value)" return-type="System.String" /><sw:example-ref id="Examples/Long.htm" language="C#" source="/Examples/Long.htm" /><sw:example-ref id="Examples/Missing.cs" language="VB.NET" source="/Samples\\Missing.cs" /></member>
<member name="T:Proactive.Options_e"><summary>Options.</summary></member>
<member name="F:Proactive.Options_e.Flag"><summary>0x10; Flag description</summary><value>needle-value</value></member>
<member name="F:Proactive.Options_e.Fallback"><summary>Fallback field</summary><value>0x20</value></member>
</members></doc>`;
  const examplesXml = `<doc xmlns:sw="${XML_NAMESPACE}"><assembly><name>SolidWorks.Interop.examples</name></assembly><members /><sw:examples><sw:example id="Examples/Long.htm" title="Long example" language="C#" source="/Examples/Long.htm"><sw:applies-to cref="M:Proactive.Widget.DoThing(System.String)" /><sw:content format="solidworks-example"><![CDATA[${content}]]></sw:content></sw:example></sw:examples></doc>`;
  return [["Proactive.xml", memberXml], ["SolidWorks.Interop.examples.xml", examplesXml]];
}
function sourcePathFixtureEntries() {
  const apiXml = `<doc xmlns:sw="${XML_NAMESPACE}"><assembly><name>SourcePaths</name></assembly><members><member name="T:SourcePaths.Widget"><summary>Widget</summary></member></members></doc>`;
  const examplesXml = `<doc xmlns:sw="${XML_NAMESPACE}"><assembly><name>SolidWorks.Interop.examples</name></assembly><members /><sw:examples><sw:example id="Catalog/Example.htm" title="Source example" source="/Samples\\Example.cs" language="C#"><sw:content><![CDATA[source example]]></sw:content></sw:example></sw:examples></doc>`;
  const guidesXml = `<doc xmlns:sw="${XML_NAMESPACE}"><assembly><name>SolidWorks.Interop.guides</name></assembly><members /><sw:guides><sw:guide id="catalog/Guide.md" title="Source guide" source="docs\\Guide.md"><sw:content><![CDATA[source guide]]></sw:content></sw:guide></sw:guides></doc>`;
  return [["SourcePaths.xml", apiXml], ["SolidWorks.Interop.examples.xml", examplesXml], ["SolidWorks.Interop.guides.xml", guidesXml]];
}
test("reclaims live-PID install locks past the absolute age ceiling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solidworks-install-lock-test-"));
  const lockPath = path.join(root, "lock");
  try {
    await mkdir(lockPath);
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      createdAt: Date.now() - 601_000,
      token: "stale-test",
    }));
    assert.equal(await reclaimStaleInstallLock(lockPath), true);
    await assert.rejects(access(lockPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexes XMLDoc members, signatures, enum values, examples, guides, and globs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solidworks-docs-test-"));
  const bundle = path.join(root, "fixture.xmldoc.zip");
  await writeFile(bundle, zip(fixtureEntries()));
  const docs = new SolidWorksDocs({ bundlePath: bundle, cacheDir: path.join(root, "cache") });

  try {
    const status = await docs.status();
    assert.deepEqual(status.counts, { assemblies: 1, types: 2, enums: 1, members: 2, examples: 1, guides: 1 });
    assert.equal(textFromXml("List&lt;Widget&gt; and x &lt; 5"), "List<Widget> and x < 5");
    assert.equal(textFromXml("<![CDATA[List<Widget>]]>"), "List<Widget>");
    assert.equal(textFromXml("one<para>two</para><br/>three"), "one two\n\nthree");
    const type = await docs.get({ kind: "type", name: "Widget" });
    assert.match(type.type.summary, /List<Widget> and x < 5/);
    const typeMember = type.type.members.find((member) => member.id === "M:Demo.Widget.DoThing(System.Int32@)");
    assert.ok(typeMember);
    assert.equal(typeMember.signature.parameters[0].direction, "byref");
    assert.equal(typeMember.parameters[0].description, "The input <value>.");
    assert.equal(typeMember.parameters[0].name, "value");
    assert.equal(typeMember.exampleRefs[0].id, "Examples/DoThing.htm");
    assert.deepEqual(typeMember.seeAlso.map((reference) => reference.cref).sort(), ["T:Demo.Other", "T:Demo.Widget"]);
    assert.equal(typeMember.seeAlso.find((reference) => reference.cref === "T:Demo.Other").text, "Other reference");

    const enumResult = await docs.get({ kind: "enum", name: "enums/Options_e" });
    assert.equal(enumResult.found, true);
    assert.equal((await docs.get({ kind: "enum", name: "Widget" })).found, false);
    assert.equal(enumResult.type.members[0].enumValue, 3);

    const example = await docs.get({ kind: "example", name: "examples/Examples/DoThing.htm" });
    assert.equal(example.found, true);
    assert.match(example.example.content, /<code>var result/);

    const guide = await docs.get({ kind: "guide", name: "root1/Guide.md" });
    assert.equal(guide.found, true);
    assert.match(guide.guide.content, /Literal <tag> content/);

    const wildcardGlob = await docs.glob("*Demo*");
    assert.ok(wildcardGlob.count > 0);
    const glob = await docs.glob("types/**/Widget");
    assert.equal(glob.count, 1);
    const overview = await docs.glob("types/Widget/_overview.md");
    assert.equal(overview.count, 1);
    assert.equal((await docs.get({ kind: "type", name: "types/Widget/_overview.md" })).found, true);
    assert.equal(glob.matches[0].id, "T:Demo.Widget");

    assert.equal((await docs.search({ query: "ref int value", kind: "member" })).count, 1);
    assert.equal((await docs.search({ query: "C#", kind: "member" })).count, 1);
    const search = await docs.search({ query: "DoThing", kind: "member", caseSensitive: true });
    assert.equal(search.caseSensitive, true);
    assert.equal(search.count, 1);
    const kindSearch = await docs.search({ query: "Do", kind: "method", limit: 20 });
    assert.ok(kindSearch.results.length > 0);
    assert.ok(kindSearch.results.every((result) => result.kind === "method"));
    const exampleSearch = await docs.search({ query: "Do", kind: "example" });
    assert.equal(exampleSearch.count, 1);

    const dispatched = await dispatchTool(docs, "list", { kind: "type", query: "Widget" });
    assert.equal(dispatched.count, 1);
    const listedMember = await dispatchTool(docs, "list", { kind: "method", query: "DoThing" });
    assert.equal(listedMember.count, 1);
    assert.equal(listedMember.items[0].id, "M:Demo.Widget.DoThing(System.Int32@)");
    const listedTypeMembers = await dispatchTool(docs, "list", { kind: "member", type: "types/Demo/Widget" });
    assert.equal(listedTypeMembers.count, 1);
    assert.equal(listedTypeMembers.items[0].id, "M:Demo.Widget.DoThing(System.Int32@)");
    const dispatchedGet = await dispatchTool(docs, "get", { kind: "type", name: "Widget" });
    assert.equal(dispatchedGet.found, true);
    assert.equal(dispatchedGet.type.fullName, "Demo.Widget");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("returns proactive API details while bounding search example previews", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solidworks-proactive-test-"));
  const bundle = path.join(root, "fixture.xmldoc.zip");
  await writeFile(bundle, zip(proactiveFixtureEntries()));
  const docs = new SolidWorksDocs({ bundlePath: bundle, cacheDir: path.join(root, "cache") });

  try {
    const status = await docs.status();
    assert.equal(status.bundleVersion, "local");

    const searchDefinition = TOOL_DEFINITIONS.find((tool) => tool.name === "search");
    assert.equal(searchDefinition.inputSchema.properties.scope, undefined);
    assert.equal(searchDefinition.inputSchema.properties.language, undefined);

    const type = await docs.get({ kind: "type", name: "Widget" });
    assert.equal(type.type.members.length, 1);
    assert.equal(type.type.members[0].parameters[0].description, "needle-parameter");
    assert.equal(type.type.members[0].exceptions[0].description, "needle-exception");
    assert.equal(type.type.members[0].seeAlso[0].text, "needle-seealso");
    const missingExample = type.type.members[0].examples.find((example) => example.id === "Examples/Missing.cs");
    assert.equal(missingExample.language, "VB.NET");
    assert.equal(missingExample.source, "/Samples\\Missing.cs");

    const enumResult = await docs.get({ kind: "enum", name: "Options_e" });
    assert.equal(enumResult.type.members[0].enumCode, 16);
    assert.equal(enumResult.type.members[0].value, "needle-value");
    assert.equal(enumResult.type.members.find((member) => member.name === "Fallback").enumCode, 32);
    const search = await docs.search({ query: "needle-remarks" });
    assert.equal(search.kind, "all");
    assert.equal(search.count, 1);
    assert.equal(search.results[0].returns, "needle-returns");
    assert.equal(search.results[0].availability, "needle-availability");
    assert.equal(search.results[0].parameters[0].description, "needle-parameter");
    assert.equal(search.results[0].typeParameters[0].description, "needle-type-parameter");
    assert.equal(search.results[0].examples[0].id, "Examples/Long.htm");

    const valueSearch = await docs.search({ query: "needle-value" });
    assert.equal(valueSearch.count, 1);
    assert.equal(valueSearch.results[0].enumCode, 16);

    const preview = await docs.search({ query: "line-55", kind: "example" });
    assert.equal(preview.count, 1);
    assert.equal(preview.results[0].contentLineCount, 50);
    assert.equal(preview.results[0].totalLineCount, 55);
    assert.equal(preview.results[0].contentTruncated, true);
    assert.doesNotMatch(preview.results[0].content, /line-55/);

    const example = await docs.get({ kind: "example", name: "Examples/Long.htm" });
    assert.match(example.example.content, /line-55/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("normalizes Windows and leading-slash catalog source paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solidworks-source-path-test-"));
  const bundle = path.join(root, "fixture.xmldoc.zip");
  await writeFile(bundle, zip(sourcePathFixtureEntries()));
  const docs = new SolidWorksDocs({ bundlePath: bundle, cacheDir: path.join(root, "cache") });

  try {
    const example = await docs.get({ kind: "example", name: "examples/Samples/Example.cs" });
    assert.equal(example.found, true);
    assert.equal(example.example.id, "Catalog/Example.htm");
    const guide = await docs.get({ kind: "guide", name: "guides/docs/Guide.md" });
    assert.equal(guide.found, true);
    assert.equal(guide.guide.id, "catalog/Guide.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves qualified lookup paths and filters example searches by assembly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solidworks-qualified-test-"));
  const bundle = path.join(root, "fixture.xmldoc.zip");
  await writeFile(bundle, zip(qualifiedFixtureEntries()));
  const docs = new SolidWorksDocs({ bundlePath: bundle, cacheDir: path.join(root, "cache") });

  try {
    const type = await docs.get({ kind: "type", name: "types/Assembly.A/Widget" });
    assert.equal(type.found, true);
    const qualifiedWithAssembly = await docs.get({ kind: "type", name: "types/Assembly.A/Widget", assembly: "Assembly.A" });
    assert.equal(qualifiedWithAssembly.found, true);
    assert.equal(type.type.assembly, "Assembly.A");
    const member = type.type.members.find((candidate) => candidate.id === "M:Assembly.A.Widget.DoThing");
    assert.ok(member);
    assert.equal(member.assembly, "Assembly.A");
    assert.deepEqual(member.exampleIds, ["Examples/A.htm"]);
    assert.equal(member.examples[0].id, "Examples/A.htm");
    const examples = await docs.search({ query: "Shared", kind: "example", assembly: "Assembly.A" });
    assert.deepEqual(examples.results.map((result) => result.id), ["Examples/A.htm"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps XMLDoc identities assembly-scoped and indexes duplicate embedded examples", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solidworks-identity-test-"));
  const bundle = path.join(root, "fixture.xmldoc.zip");
  await writeFile(bundle, zip(duplicateAssemblyFixtureEntries()));
  const docs = new SolidWorksDocs({ bundlePath: bundle, cacheDir: path.join(root, "cache") });

  try {
    const assemblyA = await docs.get({ kind: "type", name: "types/Assembly.A/Widget" });
    const assemblyB = await docs.get({ kind: "type", name: "types/Assembly.B/Widget" });
    assert.equal(assemblyA.found, true);
    assert.equal(assemblyB.found, true);
    assert.equal(assemblyA.type.assembly, "Assembly.A");
    assert.equal(assemblyB.type.assembly, "Assembly.B");
    assert.equal(assemblyA.type.members[0].assembly, "Assembly.A");
    assert.equal(assemblyB.type.members[0].assembly, "Assembly.B");
    const generatedExamples = await docs.list({ kind: "example", query: "embedded content", limit: 10 });
    assert.deepEqual(generatedExamples.items.map((item) => item.id).sort(), [
      "Assembly.A/M:Shared.Widget.DoThing#example-1",
      "Assembly.B/M:Shared.Widget.DoThing#example-1",
    ]);
    const example = await docs.get({ kind: "example", name: "Examples/Embedded.htm" });
    assert.equal(example.found, true);
    assert.match(example.example.content, /^Intro embedded <tag> example outro$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pages type members and search results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solidworks-pagination-test-"));
  const bundle = path.join(root, "fixture.xmldoc.zip");
  await writeFile(bundle, zip(paginationFixtureEntries()));
  const docs = new SolidWorksDocs({ bundlePath: bundle, cacheDir: path.join(root, "cache") });

  try {
    const type = await docs.get({ kind: "type", name: "Page.Widget", memberOffset: 1, memberLimit: 1 });
    assert.equal(type.found, true);
    assert.equal(type.type.memberOffset, 1);
    assert.equal(type.type.membersTotal, 12);
    assert.deepEqual(type.type.members.map((member) => member.name), ["Field2"]);
    assert.equal(type.type.membersTruncated, true);

    const firstSearch = await docs.search({ query: "Field", kind: "member" });
    assert.equal(firstSearch.limit, 10);
    assert.equal(firstSearch.offset, 0);
    assert.equal(firstSearch.count, 10);
    assert.equal(firstSearch.total, 12);
    assert.equal(firstSearch.truncated, true);
    assert.equal(firstSearch.nextOffset, 10);
    const secondSearch = await docs.search({ query: "Field", kind: "member", offset: firstSearch.nextOffset });
    assert.equal(secondSearch.offset, 10);
    assert.equal(secondSearch.count, 2);
    assert.equal(secondSearch.total, 12);
    assert.equal(secondSearch.truncated, false);
    assert.equal(secondSearch.nextOffset, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selects the canonical release asset and rejects unsafe ZIP paths", async () => {
  assert.equal(selectReleaseAsset([
    { name: "notes.txt" },
    { name: "SolidWorks.Interop.xmldoc.v3.11.0.zip" },
    { name: "SolidWorks.Interop.llms.v3.11.0.zip" },
  ]).name, "SolidWorks.Interop.xmldoc.v3.11.0.zip");

  const root = await mkdtemp(path.join(os.tmpdir(), "solidworks-zip-test-"));
  try {
    await assert.rejects(unpackZip(zip([["../escape.txt", "no"]]), path.join(root, "out")), /Unsafe ZIP entry path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects ZIP CRC mismatches, unsafe directories, and bounded deflate expansion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solidworks-zip-integrity-test-"));
  try {
    const crcCorrupt = zip([["ok.txt", "content"]]);
    const centralOffset = crcCorrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    crcCorrupt.writeUInt32LE(0, centralOffset + 16);
    await assert.rejects(unpackZip(crcCorrupt, path.join(root, "crc")), /ZIP CRC mismatch/);

    const unsafeDirectory = zip([["../", ""]]);
    await assert.rejects(unpackZip(unsafeDirectory, path.join(root, "directory")), /Unsafe ZIP entry path/);
    const emptyDeflateDir = path.join(root, "empty-deflate");
    await unpackZip(zip([["empty.txt", "", 8]]), emptyDeflateDir);
    assert.equal((await readFile(path.join(emptyDeflateDir, "empty.txt"))).length, 0);

    const deflateExpansion = zip([["bomb.txt", "x".repeat(1024), 8]]);
    const deflateCentralOffset = deflateExpansion.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    deflateExpansion.writeUInt32LE(1, deflateCentralOffset + 24);
    await assert.rejects(unpackZip(deflateExpansion, path.join(root, "deflate")), /larger than the maximum buffer size|Cannot create a buffer larger|output/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("downloads a release asset once and reuses the extracted cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solidworks-release-test-"));
  const bundle = zip(fixtureEntries());
  let metadataRequests = 0;
  let assetRequests = 0;
  const releaseApi = "https://release.test/latest";
  const fetchImpl = async (url) => {
    if (url === releaseApi) {
      metadataRequests += 1;
      return { ok: true, json: async () => ({ tag_name: "v-test", html_url: "https://release.test/v-test", assets: [{ name: "SolidWorks.Interop.xmldoc.v-test.zip", browser_download_url: "https://release.test/bundle.zip" }] }) };
    }
    assetRequests += 1;
    return { ok: true, arrayBuffer: async () => bundle };
  };

  try {
    const docs = new SolidWorksDocs({ cacheDir: path.join(root, "cache"), releaseApi, fetchImpl });
    const firstStatus = await docs.status();
    assert.equal(firstStatus.bundleVersion, "v-test");
    assert.equal(firstStatus.latestOnline.bundleVersion, "v-test");
    assert.equal(firstStatus.latestOnline.releaseUrl, "https://release.test/v-test");
    assert.equal(firstStatus.updateAvailable, false);
    assert.equal((await docs.search({ query: "DoThing", kind: "member" })).count, 1);
    assert.equal(metadataRequests, 1);
    assert.equal(assetRequests, 1);
    const secondStatus = await docs.status();
    assert.equal(secondStatus.latestOnline.bundleVersion, "v-test");
    assert.equal(metadataRequests, 2);
    const onlineDocs = new SolidWorksDocs({ cacheDir: path.join(root, "cache"), releaseApi, fetchImpl });
    assert.equal((await onlineDocs.status()).bundleVersion, "v-test");
    assert.equal(metadataRequests, 3);
    assert.equal((await onlineDocs.status()).counts.types, 2);
    assert.equal(metadataRequests, 4);
    assert.equal(assetRequests, 1);


    const offlineDocs = new SolidWorksDocs({
      cacheDir: path.join(root, "cache"),
      releaseApi,
      fetchImpl: async () => { throw new Error("offline"); },
    });
    assert.equal((await offlineDocs.status()).counts.guides, 1);
    await assert.rejects(offlineDocs.refresh(), /Unable to fetch SolidWorks XMLDoc release metadata/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a newer online release without downloading it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solidworks-release-status-test-"));
  const bundle = zip(fixtureEntries());
  let tag = "v-old";
  let assetRequests = 0;
  const releaseApi = "https://release.test/latest";
  const fetchImpl = async (url) => {
    if (url === releaseApi) return { ok: true, json: async () => ({ tag_name: tag, html_url: `https://release.test/${tag}`, assets: [{ name: `SolidWorks.Interop.xmldoc.${tag}.zip`, browser_download_url: "https://release.test/bundle.zip" }] }) };
    assetRequests += 1;
    return { ok: true, arrayBuffer: async () => bundle };
  };

  try {
    const docs = new SolidWorksDocs({ cacheDir: path.join(root, "cache"), releaseApi, fetchImpl });
    assert.equal((await docs.status()).updateAvailable, false);
    tag = "v-new";
    const status = await docs.status();
    assert.equal(status.bundleVersion, "v-old");
    assert.equal(status.latestOnline.bundleVersion, "v-new");
    assert.equal(status.latestOnline.releaseUrl, "https://release.test/v-new");
    assert.equal(status.updateAvailable, true);
    assert.equal(assetRequests, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a release asset whose digest does not match", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solidworks-digest-test-"));
  const bundle = zip(fixtureEntries());
  const releaseApi = "https://release.test/latest";
  const fetchImpl = async (url) => url === releaseApi
    ? { ok: true, json: async () => ({ tag_name: "v-bad", assets: [{ name: "SolidWorks.Interop.xmldoc.v-bad.zip", browser_download_url: "https://release.test/bundle.zip", digest: `sha256:${"0".repeat(64)}` }] }) }
    : { ok: true, arrayBuffer: async () => bundle };
  try {
    const docs = new SolidWorksDocs({ cacheDir: path.join(root, "cache"), releaseApi, fetchImpl });
    await assert.rejects(docs.status(), /checksum mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sets abort timeouts on release metadata and asset requests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solidworks-timeout-test-"));
  const bundle = zip(fixtureEntries());
  const releaseApi = "https://release.test/latest";
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return url === releaseApi
      ? { ok: true, json: async () => ({ tag_name: "v-timeout", assets: [{ name: "SolidWorks.Interop.xmldoc.v-timeout.zip", browser_download_url: "https://release.test/bundle.zip" }] }) }
      : { ok: true, arrayBuffer: async () => bundle };
  };
  try {
    await new SolidWorksDocs({ cacheDir: path.join(root, "cache"), releaseApi, fetchImpl }).status();
    assert.equal(requests.length, 2);
    assert.ok(requests.every(({ options }) => options.signal instanceof AbortSignal));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes shared release updates and prunes obsolete bundles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solidworks-concurrency-test-"));
  const cacheDir = path.join(root, "cache");
  const releaseApi = "https://release.test/latest";
  const bundles = { v1: zip(fixtureEntries("v1")), v2: zip(fixtureEntries("v2")) };
  let version = "v1";
  let assetRequests = 0;
  const fetchImpl = async (url) => {
    if (url === releaseApi) {
      return { ok: true, json: async () => ({ tag_name: version, html_url: `https://release.test/${version}`, assets: [{ name: `SolidWorks.Interop.xmldoc.${version}.zip`, browser_download_url: `https://release.test/${version}.zip` }] }) };
    }
    assetRequests += 1;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    return { ok: true, arrayBuffer: async () => bundles[version] };
  };

  try {
    const first = new SolidWorksDocs({ cacheDir, releaseApi, fetchImpl });
    const second = new SolidWorksDocs({ cacheDir, releaseApi, fetchImpl });
    const [firstStatus, secondStatus] = await Promise.all([first.status(), second.status()]);
    assert.equal(firstStatus.counts.types, 2);
    assert.equal(secondStatus.counts.types, 2);
    assert.equal(assetRequests, 1);
    const firstMetadata = JSON.parse(await readFile(path.join(cacheDir, "bundle.json"), "utf8"));

    version = "v2";
    await first.refresh();
    const secondMetadata = JSON.parse(await readFile(path.join(cacheDir, "bundle.json"), "utf8"));
    assert.notEqual(firstMetadata.extractedDir, secondMetadata.extractedDir);
    await assert.rejects(access(firstMetadata.extractedDir));
    await access(secondMetadata.extractedDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prunes obsolete local bundle extractions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solidworks-local-cache-test-"));
  const cacheDir = path.join(root, "cache");
  const firstBundle = path.join(root, "first.xmldoc.zip");
  const secondBundle = path.join(root, "second.xmldoc.zip");
  await writeFile(firstBundle, zip(fixtureEntries("first")));
  await writeFile(secondBundle, zip(fixtureEntries("second")));

  try {
    await new SolidWorksDocs({ bundlePath: firstBundle, cacheDir }).status();
    const firstMetadata = JSON.parse(await readFile(path.join(cacheDir, "bundle.json"), "utf8"));
    await new SolidWorksDocs({ bundlePath: secondBundle, cacheDir }).status();
    const secondMetadata = JSON.parse(await readFile(path.join(cacheDir, "bundle.json"), "utf8"));
    assert.notEqual(firstMetadata.extractedDir, secondMetadata.extractedDir);
    await assert.rejects(access(firstMetadata.extractedDir));
    await access(secondMetadata.extractedDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("prunes stale temporary bundle extractions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solidworks-staging-cleanup-test-"));
  const cacheDir = path.join(root, "cache");
  const bundle = path.join(root, "bundle.xmldoc.zip");
  const stalePath = path.join(cacheDir, "extracted", "local-crashed.tmp-old");
  try {
    await writeFile(bundle, zip(fixtureEntries("staging")));
    await mkdir(stalePath, { recursive: true });
    const staleTime = new Date(Date.now() - 901_000);
    await utimes(stalePath, staleTime, staleTime);
    await new SolidWorksDocs({ bundlePath: bundle, cacheDir }).status();
    await assert.rejects(access(stalePath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps the previous cache when replacement validation fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solidworks-invalid-cache-test-"));
  const cacheDir = path.join(root, "cache");
  const releaseApi = "https://release.test/latest";
  const validBundle = zip(fixtureEntries("valid"));
  const invalidBundle = zip([["manifest.xml", `<doc xmlns:sw="${XML_NAMESPACE}"><assembly><name>Invalid</name></assembly><members><member name="T:"><summary>malformed</summary></member></members></doc>`]]);
  const validRelease = { tag_name: "v-valid", assets: [{ name: "SolidWorks.Interop.xmldoc.v-valid.zip", browser_download_url: "https://release.test/valid.zip" }] };
  const invalidRelease = { tag_name: "v-invalid", assets: [{ name: "SolidWorks.Interop.xmldoc.v-invalid.zip", browser_download_url: "https://release.test/invalid.zip" }] };

  try {
    const seedFetch = async (url) => url === releaseApi
      ? { ok: true, json: async () => validRelease }
      : { ok: true, arrayBuffer: async () => validBundle };
    await new SolidWorksDocs({ cacheDir, releaseApi, fetchImpl: seedFetch }).status();
    const previousMetadata = JSON.parse(await readFile(path.join(cacheDir, "bundle.json"), "utf8"));

    const invalidFetch = async (url) => url === releaseApi
      ? { ok: true, json: async () => invalidRelease }
      : { ok: true, arrayBuffer: async () => invalidBundle };
    await assert.rejects(new SolidWorksDocs({ cacheDir, releaseApi, fetchImpl: invalidFetch }).refresh(), /no indexed API types/);

    const currentMetadata = JSON.parse(await readFile(path.join(cacheDir, "bundle.json"), "utf8"));
    assert.equal(currentMetadata.extractedDir, previousMetadata.extractedDir);
    await access(currentMetadata.extractedDir);
    const offline = new SolidWorksDocs({ cacheDir, releaseApi, fetchImpl: async () => { throw new Error("offline"); } });
    assert.equal((await offline.status()).counts.types, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports forced refresh acquisition failures instead of stale success", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solidworks-refresh-failure-test-"));
  const cacheDir = path.join(root, "cache");
  const bundle = zip(fixtureEntries());
  const releaseApi = "https://release.test/latest";
  const release = { tag_name: "v-test", html_url: "https://release.test/v-test", assets: [{ name: "SolidWorks.Interop.xmldoc.v-test.zip", browser_download_url: "https://release.test/bundle.zip" }] };
  const seedFetch = async (url) => url === releaseApi
    ? { ok: true, json: async () => release }
    : { ok: true, arrayBuffer: async () => bundle };

  try {
    await new SolidWorksDocs({ cacheDir, releaseApi, fetchImpl: seedFetch }).status();
    const failures = [
      {
        fetchImpl: async () => { throw new Error("offline"); },
        expected: /Unable to fetch SolidWorks XMLDoc release metadata/,
      },
      {
        fetchImpl: async (url) => url === releaseApi
          ? { ok: true, json: async () => ({ ...release, assets: [] }) }
          : { ok: true, arrayBuffer: async () => bundle },
        expected: /latest SolidWorks release has no xmldoc ZIP asset/,
      },
      {
        fetchImpl: async (url) => url === releaseApi
          ? { ok: true, json: async () => release }
          : { ok: false, status: 503 },
        expected: /HTTP 503 downloading/,
      },
    ];
    for (const failure of failures) {
      const docs = new SolidWorksDocs({ cacheDir, releaseApi, fetchImpl: failure.fetchImpl });
      await assert.doesNotReject(docs.status());
      await assert.rejects(docs.refresh(), failure.expected);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("passes the bundled skill through MCP server instructions", () => {
  const skill = readFileSync(
    new URL("../plugins/developing-solidworks/skills/developing-solidworks/SKILL.md", import.meta.url),
    "utf8",
  ).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
  assert.ok(SERVER_INSTRUCTIONS.startsWith("The bundled developing-solidworks skill below is authoritative."));
  assert.ok(SERVER_INSTRUCTIONS.endsWith(skill));
});

test("publishes the consolidated documented MCP tool set", () => {
  assert.equal(SERVER_VERSION, "0.9.8");
  assert.deepEqual(TOOL_DEFINITIONS.map((tool) => tool.name), [
    "status", "refresh", "glob", "search", "list", "get",
  ]);
  assert.equal(TOOL_DEFINITIONS.some((tool) => tool.name.startsWith("get_")), false);
  assert.equal(TOOL_DEFINITIONS.some((tool) => tool.name === "list_members" || tool.name === "get_member"), false);
  const list = TOOL_DEFINITIONS.find((tool) => tool.name === "list");
  const get = TOOL_DEFINITIONS.find((tool) => tool.name === "get");
  const search = TOOL_DEFINITIONS.find((tool) => tool.name === "search");
  assert.deepEqual(list.inputSchema.properties.kind.default, "all");
  assert.deepEqual(list.inputSchema.properties.type, { type: "string", minLength: 1 });
  assert.deepEqual(list.inputSchema.properties.root, { type: "string" });
  assert.deepEqual(get.inputSchema.properties.kind.enum, ["type", "enum", "example", "guide"]);
  assert.deepEqual(get.inputSchema.required, ["kind", "name"]);
  assert.equal(search.inputSchema.properties.scope, undefined);
  assert.equal(search.inputSchema.properties.language, undefined);
  assert.deepEqual(search.inputSchema.properties.kind.enum, list.inputSchema.properties.kind.enum);
  assert.equal(search.inputSchema.properties.limit.default, 10);
});
