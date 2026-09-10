import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
    receivedAt: "2026-09-10T12:00:00.000Z",
    changes: ["head"],
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
    url: `http://127.0.0.1:${port}/monitor/test-capability`,
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

test("prints an intermediate event and keeps the same watcher alive", async () => {
  const { server, url } = await startServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    sendEvent(response, monitorEvent("event-1"));
  });
  const watcher = startWatcher(url);

  try {
    await waitFor(() => watcher.stdout().includes("\n"), "the intermediate event");
    assert.equal(watcher.child.exitCode, null);
    assert.deepEqual(JSON.parse(watcher.stdout().trim()), monitorEvent("event-1"));

    watcher.child.kill("SIGTERM");
    assert.deepEqual(await watcher.exited, { code: 0, signal: null });
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
      changes: ["state"],
    }));
  });
  const watcher = startWatcher(`${url}?cursor=initial-cursor`);

  try {
    assert.deepEqual(await watcher.exited, { code: 0, signal: null });
    assert.equal(requestHeaders.length, 2);
    assert.equal(requestHeaders[0]["last-event-id"], undefined);
    assert.equal(requestHeaders[1]["last-event-id"], "event-1");
    const output = watcher.stdout().trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(output.map(({ id }) => id), ["event-1", "event-2"]);
    assert.equal(output[1].terminalState, "closed");
    assert.equal(watcher.stderr(), "");
  } finally {
    if (watcher.child.exitCode === null) watcher.child.kill("SIGKILL");
    await closeServer(server);
  }
});

test("prints a merged event and exits without waiting for the feed to close", async () => {
  const { server, url } = await startServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    sendEvent(response, monitorEvent("event-terminal", "merged", {
      action: "closed",
      changes: ["merged", "state"],
    }));
  });
  const watcher = startWatcher(url);

  try {
    assert.deepEqual(await watcher.exited, { code: 0, signal: null });
    assert.equal(JSON.parse(watcher.stdout().trim()).terminalState, "merged");
    assert.equal(watcher.stderr(), "");
  } finally {
    if (watcher.child.exitCode === null) watcher.child.kill("SIGKILL");
    await closeServer(server);
  }
});

for (const status of [401, 403, 404]) {
  test(`reports HTTP ${status} as a permanent authorization failure`, async () => {
    let requests = 0;
    const { server, url } = await startServer((_request, response) => {
      requests += 1;
      response.writeHead(status).end();
    });
    const watcher = startWatcher(url);

    try {
      const result = await watcher.exited;
      assert.equal(result.code, 1);
      assert.equal(result.signal, null);
      assert.equal(requests, 1);
      assert.equal(watcher.stdout(), "");
      assert.match(watcher.stderr(), new RegExp(`HTTP ${status}`));
      assert.match(watcher.stderr(), /root session.*unwatch_pr/);
    } finally {
      if (watcher.child.exitCode === null) watcher.child.kill("SIGKILL");
      await closeServer(server);
    }
  });
}

test("rejects non-HTTP URLs even when their hostname is loopback", async () => {
  const watcher = startWatcher("file://localhost/monitor/test-capability");

  assert.deepEqual(await watcher.exited, { code: 1, signal: null });
  assert.equal(watcher.stdout(), "");
  assert.match(watcher.stderr(), /HTTPS or loopback HTTP/);
});
