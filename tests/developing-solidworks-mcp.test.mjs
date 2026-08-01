import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SolidWorksDocs,
  TOOL_DEFINITIONS,
  dispatchTool,
  selectReleaseAsset,
  unpackZip,
} from "../plugins/developing-solidworks/mcp/solidworks-docs.mjs";

const XML_NAMESPACE = "urn:solidworks:offline-xmldoc:1";

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(Buffer.concat([local, nameBuffer, data]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
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

function fixtureEntries() {
  const memberXml = `<doc xmlns:sw="${XML_NAMESPACE}"><assembly><name>Demo</name></assembly><members>
+<member name="T:Demo.Widget"><summary>A Widget type.</summary><sw:signature kind="type" display="class Widget" /></member>
+<member name="M:Demo.Widget.DoThing(System.Int32@)"><summary>Does a thing.</summary><param name="value">The input value.</param><returns>The result.</returns><sw:signature kind="method" display="int DoThing(ref int value)" return-type="System.Int32"><sw:parameter name="value" type="System.Int32@" direction="byref" /></sw:signature><sw:example-ref id="Examples/DoThing.htm" language="C#" source="/Examples/DoThing.htm" /></member>
+<member name="T:Demo.Options_e"><summary>Options.</summary></member>
+<member name="F:Demo.Options_e.OptionA"><summary>3; a documented value</summary></member>
+</members></doc>`.replaceAll("\n+", "\n");
  const examplesXml = `<doc xmlns:sw="${XML_NAMESPACE}"><assembly><name>SolidWorks.Interop.examples</name></assembly><members /><sw:examples><sw:example id="Examples/DoThing.htm" title="Do Thing" language="C#" source="/Examples/DoThing.htm"><sw:applies-to cref="M:Demo.Widget.DoThing(System.Int32@)" /><sw:content format="solidworks-example"><![CDATA[<code>var result = widget.DoThing(ref value);</code>]]></sw:content></sw:example></sw:examples></doc>`;
  const guidesXml = `<doc xmlns:sw="${XML_NAMESPACE}"><assembly><name>SolidWorks.Interop.guides</name></assembly><members /><sw:guides><sw:guide id="root1/Guide.md" title="Guide" source="Guide.md" root="root1"><sw:content format="markdown"><![CDATA[# Guide\n\nLiteral <tag> content.]]></sw:content></sw:guide></sw:guides></doc>`;
  return [
    ["Demo.xml", memberXml],
    ["SolidWorks.Interop.examples.xml", examplesXml],
    ["SolidWorks.Interop.guides.xml", guidesXml],
  ];
}

test("indexes XMLDoc members, signatures, enum values, examples, guides, and globs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solidworks-docs-test-"));
  const bundle = path.join(root, "fixture.xmldoc.zip");
  await writeFile(bundle, zip(fixtureEntries()));
  const docs = new SolidWorksDocs({ bundlePath: bundle, cacheDir: path.join(root, "cache") });

  try {
    const status = await docs.status();
    assert.deepEqual(status.counts, { assemblies: 1, types: 2, enums: 1, members: 2, examples: 1, guides: 1 });

    const member = await docs.getMember({ name: "M:Demo.Widget.DoThing(System.Int32@)" });
    assert.equal(member.found, true);
    assert.equal(member.member.signature.parameters[0].direction, "byref");
    assert.equal(member.member.parameters[0].name, "value");
    assert.equal(member.member.exampleRefs[0].id, "Examples/DoThing.htm");

    const enumResult = await docs.getEnum({ name: "enums/Options_e" });
    assert.equal(enumResult.found, true);
    assert.equal(enumResult.type.members[0].enumValue, 3);
    assert.equal((await docs.getMember({ name: "members/Demo/Widget/DoThing" })).found, true);

    const example = await docs.getExample({ name: "examples/Examples/DoThing.htm" });
    assert.equal(example.found, true);
    assert.match(example.example.content, /<code>var result/);

    const guide = await docs.getGuide({ name: "root1/Guide.md" });
    assert.equal(guide.found, true);
    assert.match(guide.guide.content, /Literal <tag> content/);

    const glob = await docs.glob("types/**/Widget");
    assert.equal(glob.count, 1);
    const overview = await docs.glob("types/Widget/_overview.md");
    assert.equal(overview.count, 1);
    assert.equal((await docs.getType({ name: "types/Widget/_overview.md" })).found, true);
    assert.equal(glob.matches[0].id, "T:Demo.Widget");

    assert.equal((await docs.search({ query: "ref int value", scope: "members" })).count, 1);
    assert.equal((await docs.search({ query: "C#", scope: "members" })).count, 1);
    const search = await docs.search({ query: "DoThing", scope: "members", caseSensitive: true });
    assert.equal(search.caseSensitive, true);
    assert.equal(search.count, 1);

    const dispatched = await dispatchTool(docs, "list_types", { query: "Widget" });
    assert.equal(dispatched.count, 1);
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
    assert.equal((await docs.status()).counts.types, 2);
    assert.equal((await docs.search({ query: "DoThing", scope: "members" })).count, 1);
    assert.equal(metadataRequests, 1);
    assert.equal(assetRequests, 1);

    const offlineDocs = new SolidWorksDocs({
      cacheDir: path.join(root, "cache"),
      releaseApi,
      fetchImpl: async () => { throw new Error("offline"); },
    });
    assert.equal((await offlineDocs.status()).counts.guides, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publishes the complete documented MCP tool set", () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((tool) => tool.name), [
    "status", "refresh", "glob", "search", "list_assemblies", "list_types",
    "get_type", "list_members", "get_member", "list_enums", "get_enum",
    "list_examples", "get_example", "list_guides", "get_guide",
  ]);
});
