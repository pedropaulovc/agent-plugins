import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatMonitorEvent } from "../plugins/watch-pr/skills/watch-pr/watch-pr-monitor.mjs";

const watcherPath = fileURLToPath(new URL(
  "../plugins/watch-pr/skills/watch-pr/watch-pr-monitor.mjs",
  import.meta.url,
));

function monitorEvent(id, terminalState = "watching", overrides = {}) {
  return {
    id,
    repository: "owner/repository",
    pullRequestNumber: 42,
    githubEvent: "pull_request",
    action: "synchronize",
    receivedAt: "2026-09-19T12:00:00.000Z",
    changes: ["checks"],
    details: ["checks: rerun started (pending: CI, Lint)"],
    terminalState,
    ...overrides,
  };
}

function sendEvent(response, event) {
  response.write(`id: ${event.id}\nevent: pr\ndata: ${JSON.stringify(event)}\n\n`);
}

async function startServer(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    server,
    url: `http://127.0.0.1:${port}/monitor/transcript-safe-capability`,
  };
}

function startWatcher(url) {
  const child = spawn(process.execPath, [watcherPath, url], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));
  return {
    child,
    exited,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function stopWatcher(watcher) {
  watcher.child.kill("SIGTERM");
  const expected = process.platform === "win32"
    ? { code: null, signal: "SIGTERM" }
    : { code: 0, signal: null };
  assert.deepEqual(await watcher.exited, expected);
}

test("prints readiness for a successful idle feed and keeps the direct URL process alive", async () => {
  const { server, url } = await startServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.flushHeaders();
  });
  const watcher = startWatcher(url);

  try {
    await waitFor(() => watcher.stdout().includes("\n"), "the readiness record");
    assert.equal(watcher.child.exitCode, null);
    assert.equal(watcher.stdout(), "watch-pr: ready\n");
    await stopWatcher(watcher);
    assert.equal(watcher.stderr(), "");
  } finally {
    if (watcher.child.exitCode === null) watcher.child.kill("SIGKILL");
    await closeServer(server);
  }
});

test("prints actionable details inline without a follow-up snapshot fetch", async () => {
  const comment = "comment #987 @reviewer https://github.com/owner/repository/pull/42#issuecomment-987: Please cover the retry race before merging.";
  const { server, url } = await startServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    sendEvent(response, monitorEvent("event-comment", "watching", {
      githubEvent: "issue_comment",
      changes: ["comments"],
      details: [comment],
    }));
  });
  const watcher = startWatcher(url);

  try {
    await waitFor(() => watcher.stdout().includes(comment), "the comment event");
    assert.deepEqual(watcher.stdout().trim().split("\n"), [
      "watch-pr: ready",
      `PR 42 updated: ${comment}`,
    ]);
    assert.equal(watcher.child.exitCode, null);
    await stopWatcher(watcher);
    assert.equal(watcher.stderr(), "");
  } finally {
    if (watcher.child.exitCode === null) watcher.child.kill("SIGKILL");
    await closeServer(server);
  }
});

test("sanitizes control characters and bounds actionable wake lines", () => {
  const line = formatMonitorEvent(monitorEvent("event-checks", "watching", {
    details: Array.from(
      { length: 6 },
      (_, index) => `detail ${index} \u001b[2K${"x".repeat(2_000)}`,
    ),
  }));

  assert.ok(line.length <= 4_096);
  assert.doesNotMatch(line, /\u001b/u);
  assert.match(line, /\+8 more changes$/u);
  const markedLine = formatMonitorEvent(monitorEvent("event-many-checks", "watching", {
    details: [
      ...Array.from({ length: 5 }, (_, index) => `check ${index}: ${"x".repeat(2_000)}`),
      "+7 more changes",
    ],
  }));
  assert.ok(markedLine.length <= 4_096);
  assert.match(markedLine, /\+13 more changes$/u);
  const unicodeLine = formatMonitorEvent(monitorEvent("event-unicode", "watching", {
    details: [`${"x".repeat(998)}😀z`],
  }));
  assert.equal(unicodeLine.isWellFormed(), true);
  assert.match(unicodeLine, /\+1 more changes$/u);
});

test("suppresses non-actionable feed churn", async () => {
  const { server, url } = await startServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    sendEvent(response, monitorEvent("event-noop", "watching", { changes: ["checks"], details: [] }));
    setTimeout(() => {
      sendEvent(response, monitorEvent("event-actionable", "watching", {
        details: ["checks: all terminal (pass: 8, fail: 0, skipping: 0, cancel: 0)"],
      }));
    }, 25);
  });
  const watcher = startWatcher(url);

  try {
    await waitFor(() => watcher.stdout().includes("all terminal"), "the terminal check summary");
    assert.deepEqual(watcher.stdout().trim().split("\n"), [
      "watch-pr: ready",
      "PR 42 updated: checks: all terminal (pass: 8, fail: 0, skipping: 0, cancel: 0)",
    ]);
    await stopWatcher(watcher);
    assert.equal(watcher.stderr(), "");
  } finally {
    if (watcher.child.exitCode === null) watcher.child.kill("SIGKILL");
    await closeServer(server);
  }
});

test("reconnects with its cursor and does not print a replay twice", async () => {
  const requestHeaders = [];
  let connection = 0;
  const { server, url } = await startServer((request, response) => {
    requestHeaders.push(request.headers);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    connection += 1;
    if (connection === 1) {
      sendEvent(response, monitorEvent("event-1"));
      response.end();
      return;
    }

    sendEvent(response, monitorEvent("event-1"));
    sendEvent(response, monitorEvent("event-2", "closed", {
      action: "closed",
      changes: ["lifecycle"],
      details: ["PR state: CLOSED"],
    }));
  });
  const watcher = startWatcher(`${url}?cursor=initial-cursor`);

  try {
    assert.deepEqual(await watcher.exited, { code: 0, signal: null });
    assert.equal(requestHeaders.length, 2);
    assert.equal(requestHeaders[0]["last-event-id"], "initial-cursor");
    assert.equal(requestHeaders[1]["last-event-id"], "event-1");
    assert.deepEqual(watcher.stdout().trim().split("\n"), [
      "watch-pr: ready",
      "PR 42 updated: checks: rerun started (pending: CI, Lint)",
      "PR 42 finished: CLOSED",
    ]);
    assert.equal(watcher.stderr(), "");
  } finally {
    if (watcher.child.exitCode === null) watcher.child.kill("SIGKILL");
    await closeServer(server);
  }
});

test("prints terminal state and exits without waiting for the feed to close", async () => {
  const { server, url } = await startServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    sendEvent(response, monitorEvent("event-terminal", "merged", {
      action: "closed",
      changes: ["lifecycle"],
      details: [],
    }));
  });
  const watcher = startWatcher(url);

  try {
    assert.deepEqual(await watcher.exited, { code: 0, signal: null });
    assert.deepEqual(watcher.stdout().trim().split("\n"), [
      "watch-pr: ready",
      "PR 42 finished: MERGED",
    ]);
    assert.equal(watcher.stderr(), "");
  } finally {
    if (watcher.child.exitCode === null) watcher.child.kill("SIGKILL");
    await closeServer(server);
  }
});

for (const status of [401, 403, 404]) {
  test(`reports HTTP ${status} as a permanent capability failure`, async () => {
    const { server, url } = await startServer((_request, response) => {
      response.writeHead(status).end();
    });
    const watcher = startWatcher(url);

    try {
      assert.deepEqual(await watcher.exited, { code: 1, signal: null });
      assert.equal(watcher.stdout(), "");
      assert.match(watcher.stderr(), new RegExp(`HTTP ${status}`));
      assert.match(watcher.stderr(), /before readiness/);
      assert.match(watcher.stderr(), /unwatch_pr/);
    } finally {
      if (watcher.child.exitCode === null) watcher.child.kill("SIGKILL");
      await closeServer(server);
    }
  });
}

test("reports the last event id when a ready capability expires", async () => {
  let connection = 0;
  const { server, url } = await startServer((_request, response) => {
    connection += 1;
    if (connection === 1) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      sendEvent(response, monitorEvent("event-before-expiry", "watching", {
        details: ["checks: rerun started (pending: CI)"],
      }));
      response.end();
      return;
    }
    response.writeHead(404).end();
  });
  const watcher = startWatcher(url);

  try {
    assert.deepEqual(await watcher.exited, { code: 1, signal: null });
    assert.deepEqual(watcher.stdout().trim().split("\n"), [
      "watch-pr: ready",
      "PR 42 updated: checks: rerun started (pending: CI)",
    ]);
    assert.match(watcher.stderr(), /after readiness/);
    assert.match(watcher.stderr(), /last event id "event-before-expiry"/);
    assert.match(watcher.stderr(), /open_pr_monitor once/);
  } finally {
    if (watcher.child.exitCode === null) watcher.child.kill("SIGKILL");
    await closeServer(server);
  }
});

test("rejects a malformed resume cursor before connecting", async () => {
  const watcher = startWatcher("https://watch-pr.test/monitor/capability?cursor=bad%0Aid");
  assert.deepEqual(await watcher.exited, { code: 1, signal: null });
  assert.equal(watcher.stdout(), "");
  assert.match(watcher.stderr(), /cursor is not a valid Last-Event-ID/);
});

test("rejects non-HTTP monitor URLs", async () => {
  const watcher = startWatcher("file://localhost/monitor/transcript-safe-capability");
  assert.deepEqual(await watcher.exited, { code: 1, signal: null });
  assert.equal(watcher.stdout(), "");
  assert.match(watcher.stderr(), /HTTPS or loopback HTTP/);
});
