import assert from "node:assert/strict";
import test from "node:test";
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
  assert.equal(Object.keys(config.command).length, 13);
  assert.ok(config.command["alt-text"]);
  assert.ok(config.command.issue);
  assert.ok(config.command.comments);
  assert.ok(config.command["watch-pr"]);
  assert.deepEqual(config.mcp["watch-pr"], {
    type: "remote",
    url: "https://watch-pr.vza.net/mcp",
  });
  assert.ok(config.command["download-solidworks-docs"]);
  assert.ok(config.command["cloudflare-temp-accounts"]);
  assert.ok(config.command.reset);
});

test("command-chain-separator rewrites OpenCode bash arguments", async () => {
  const hooks = await plugins.CommandChainSeparatorPlugin({ directory });
  const output = { args: { command: "printf one && printf two" } };
  const originalArgs = output.args;
  await hooks["tool.execute.before"](
    { tool: "bash", sessionID: "session", callID: "call" },
    output,
  );
  assert.equal(output.args, originalArgs, "OpenCode executes the original args object");
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
  const originalArgs = output.args;
  await hooks["tool.execute.before"](
    { tool: "bash", sessionID: "session", callID: "playwright" },
    output,
  );
  assert.equal(output.args, originalArgs, "OpenCode executes the original args object");
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
            {
              info: { role: "assistant", id: "assistant-1" },
              parts: [{
                type: "tool",
                tool: "apply_patch",
                state: { input: { patchText: "*** Begin Patch\n+const value = 'placeholder';\n-oldValue();\n*** End Patch" } },
              }],
            },
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
  assert.match(prompts[0].body.parts[0].text, /placeholder/);
  await hooks.event(idleEvent("session"));
  assert.equal(prompts.length, 1, "the corrective turn must not trigger a stop loop");
  await hooks.event(idleEvent("session"));
  assert.equal(prompts.length, 1, "duplicate idle events must not rescan a message");
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
