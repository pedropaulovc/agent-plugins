import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import * as plugins from "../.opencode/plugins/agent-plugins.js";

const directory = process.cwd();
const idleEvent = (sessionID) => ({ event: { type: "session.idle", properties: { sessionID } } });

test("all plugins load and register expected config", async () => {
  assert.equal(Object.keys(plugins).length, 16);
  const config = {};
  const client = {
    session: {
      messages: async () => ({ data: [] }),
      promptAsync: async () => ({ data: true }),
    },
  };
  for (const plugin of Object.values(plugins)) {
    const hooks = await plugin({ client, directory, worktree: directory });
    if (hooks.config) await hooks.config(config);
  }
  assert.equal(config.skills.paths.length, 10);
  assert.equal(Object.keys(config.command).length, 14);
  assert.ok(config.command["alt-text"]);
  assert.ok(config.command.issue);
  assert.ok(config.command.comments);
  assert.ok(config.command["watch-pr"]);
  assert.ok(config.command["download-solidworks-docs"]);
  assert.ok(config.command["memory-audit"]);
  assert.ok(config.command["record-memory-usage"]);
  assert.ok(config.command.m);
});

test("command-chain-separator rewrites OpenCode bash arguments", async () => {
  const hooks = await plugins.CommandChainSeparatorPlugin({ directory });
  const output = { args: { command: "printf one && printf two" } };
  await hooks["tool.execute.before"](
    { tool: "bash", sessionID: "session", callID: "call" },
    output,
  );
  assert.match(output.args.command, /printf '\\n\\n'/);
  const after = { title: "", output: "one\n\ntwo", metadata: {} };
  await hooks["tool.execute.after"](
    { tool: "bash", sessionID: "session", callID: "call", args: output.args },
    after,
  );
  assert.match(after.output, /inserted 1 output separator/);
});

test("no-fetch blocks ordinary URLs and strips its escape marker", async () => {
  const hooks = await plugins.NoFetchPlugin({ directory });
  await assert.rejects(
    hooks["tool.execute.before"](
      { tool: "webfetch", sessionID: "session", callID: "blocked" },
      { args: { url: "https://example.com/" } },
    ),
    /WebFetch is blocked/,
  );
  const escaped = { args: { url: "https://example.com/ [force-fetch]" } };
  await hooks["tool.execute.before"](
    { tool: "webfetch", sessionID: "session", callID: "allowed" },
    escaped,
  );
  assert.equal(escaped.args.url, "https://example.com/");
  await hooks["tool.execute.before"](
    { tool: "webfetch", sessionID: "session", callID: "excluded" },
    { args: { url: "https://docs.github.com/llms.txt" } },
  );
});

test("playwright adapter adds headed mode and returns its viewport notice", async () => {
  const hooks = await plugins.PlaywrightCliHeadedPlugin({ directory });
  const output = { args: { command: "playwright-cli open https://example.com" } };
  await hooks["tool.execute.before"](
    { tool: "bash", sessionID: "session", callID: "playwright" },
    output,
  );
  assert.match(output.args.command, /playwright-cli open --headed/);
  const after = { title: "", output: "opened", metadata: {} };
  await hooks["tool.execute.after"](
    { tool: "bash", sessionID: "session", callID: "playwright", args: output.args },
    after,
  );
  assert.match(after.output, /resize/);
});

test("mediocrity detector continues one OpenCode turn", async () => {
  const prompts = [];
  const client = {
    session: {
      messages: async () => ({
        data: prompts.length === 0
          ? [
              { info: { role: "user" }, parts: [{ type: "text", text: "Finish the task" }] },
              { info: { role: "assistant", id: "assistant-1" }, parts: [{ type: "text", text: "This placeholder is good enough for now." }] },
            ]
          : [
              { info: { role: "user" }, parts: [{ type: "text", text: "Report the assumption" }] },
              { info: { role: "assistant", id: "assistant-correction" }, parts: [{ type: "text", text: "I used a placeholder in src/example.js." }] },
            ],
      }),
      promptAsync: async (request) => prompts.push(request),
    },
  };
  const hooks = await plugins.MediocrityDetectorPlugin({ client, directory });
  await hooks.event(idleEvent("session"));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].body.parts[0].text, /Shortcut\/assumption language detected/);
  await hooks.event(idleEvent("session"));
  assert.equal(prompts.length, 1, "the corrective turn must not trigger a stop loop");
  await hooks.event(idleEvent("session"));
  assert.equal(prompts.length, 1, "duplicate idle events must not rescan a message");
});

test("memory-to-repo denies OpenCode reads of machine-local memory", async () => {
  const hooks = await plugins.MemoryToRepoPlugin({ directory });
  await assert.rejects(
    hooks["tool.execute.before"](
      { tool: "read", sessionID: "session", callID: "call" },
      { args: { filePath: "/home/user/.claude/projects/repo/memory/MEMORY.md" } },
    ),
    /machine-local auto-memory directory/,
  );
  const escaped = {
    args: { filePath: "/home/user/.claude/projects/repo/memory/local.md [force-memory]" },
  };
  await hooks["tool.execute.before"](
    { tool: "read", sessionID: "session", callID: "escaped" },
    escaped,
  );
  assert.equal(escaped.args.filePath, "/home/user/.claude/projects/repo/memory/local.md");
});

test("unrelated issue detector continues one OpenCode turn", async () => {
  const prompts = [];
  const client = {
    session: {
      messages: async () => ({
        data: [
          { info: { role: "user" }, parts: [{ type: "text", text: "Review the failures" }] },
          { info: { role: "assistant", id: "assistant-2" }, parts: [{ type: "text", text: "That failure is unrelated to this change." }] },
        ],
      }),
      promptAsync: async (request) => prompts.push(request),
    },
  };
  const hooks = await plugins.UnrelatedIssueDetectorPlugin({ client, directory });
  await hooks.event(idleEvent("unrelated-session"));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].body.parts[0].text, /Dismissal language detected/);
});

test("watch-pr wakes its OpenCode session with batched monitor events", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "watch-pr-opencode-"));
  const watchScript = path.join(tempDir, "watch-pr.sh");
  writeFileSync(watchScript, [
    "#!/usr/bin/env bash",
    "printf 'check build: pending\\nfeedback T1 src/app.js:4 reviewer title\\n'",
    "exec sleep 10",
  ].join("\n"));
  const prompts = [];
  const client = {
    app: { log: async () => {} },
    session: { promptAsync: async (request) => prompts.push(request) },
  };
  const hooks = await plugins.WatchPrPlugin(
    { client, directory, worktree: directory },
    { watchScript },
  );
  const context = { sessionID: "watch-session", directory, worktree: directory };
  try {
    const started = await hooks.tool.watch_pr.execute(
      { action: "start", ref: "123" },
      context,
    );
    assert.match(started, /notified automatically/);
    for (let attempt = 0; attempt < 20 && prompts.length === 0; attempt += 1) {
      await delay(25);
    }
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].body.parts[0].text, /check build: pending/);
    assert.match(prompts[0].body.parts[0].text, /feedback T1/);
    assert.equal(prompts[0].body.parts[0].synthetic, true);
    assert.match(
      await hooks.tool.watch_pr.execute({ action: "status" }, context),
      /monitoring 123/,
    );
    assert.equal(
      await hooks.tool.watch_pr.execute({ action: "stop" }, context),
      "Stopped the watch-pr monitor.",
    );
  } finally {
    await hooks.dispose();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("memory usage scanner records OpenCode read-tool history", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "memory-usage-opencode-"));
  const projectRoot = path.join(tempDir, "project");
  const memoryDir = path.join(projectRoot, "memory");
  const databasePath = path.join(tempDir, "opencode.db");
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(path.join(memoryDir, "topic.md"), "# Topic\n");

  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);
  `);
  database.prepare("INSERT INTO project (id, worktree) VALUES (?, ?)").run("project", projectRoot);
  database.prepare("INSERT INTO session (id, project_id, directory) VALUES (?, ?, ?)")
    .run("ses_open", "project", path.join(projectRoot, "src"));
  const insertPart = database.prepare("INSERT INTO part (id, session_id, data) VALUES (?, ?, ?)");
  const readPart = JSON.stringify({
    type: "tool",
    tool: "read",
    state: { input: { filePath: path.join(memoryDir, "topic.md") } },
  });
  insertPart.run("part-1", "ses_open", readPart);
  insertPart.run("part-2", "ses_open", readPart);
  insertPart.run("part-index", "ses_open", JSON.stringify({
    type: "tool",
    tool: "read",
    state: { input: { filePath: path.join(memoryDir, "MEMORY.md") } },
  }));
  database.close();

  try {
    const output = execFileSync(
      process.execPath,
      [path.join(directory, "plugins/memory-to-repo/scripts/record-memory-usage.ts")],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tempDir,
          CLAUDE_PROJECT_DIR: projectRoot,
          OPENCODE_DB_PATH: databasePath,
        },
      },
    );
    assert.match(output, /1 OpenCode session/);
    assert.deepEqual(
      readFileSync(path.join(memoryDir, "usage.jsonl"), "utf8").trim().split("\n").map(JSON.parse),
      [{ sessionId: "ses_open", memoryFileName: "memory/topic.md" }],
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
