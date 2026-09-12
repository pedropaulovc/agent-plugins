import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { readMonitorUrlFile } from "../plugins/watch-pr/skills/watch-pr/watch-pr-monitor.mjs";

const watcherPath = fileURLToPath(new URL(
  "../plugins/watch-pr/skills/watch-pr/watch-pr-monitor.mjs",
  import.meta.url,
));

const temporaryDirectory = mkdtempSync(join(tmpdir(), "watch-pr-monitor-test-"));
let urlFileSequence = 0;

test.after(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

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

function startWatcher(url, { createUrlFile = true, mode = 0o600 } = {}) {
  const urlFile = join(temporaryDirectory, `${urlFileSequence += 1}.url`);
  if (createUrlFile) {
    writeFileSync(urlFile, url, { encoding: "utf8", mode });
    chmodSync(urlFile, mode);
  }

  const child = spawn(process.execPath, [watcherPath, "--url-file", urlFile], {
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
    urlFile,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}
function startMint(
  monitorUrl,
  directory = process.platform === "win32" ? undefined : temporaryDirectory,
  { sendInput = true } = {},
) {
  const args = [watcherPath, "mint"];
  if (directory !== undefined) args.push(directory);
  const child = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));
  if (sendInput) child.stdin.write(`${monitorUrl}\n`);
  return {
    child,
    exited,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}
function capabilityNames(directory = tmpdir()) {
  return new Set(readdirSync(directory).filter(name => name.startsWith("watch-pr-monitor-")));
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function assertWatcherStoppedByTest(exited) {
  const expected = process.platform === "win32"
    ? { code: null, signal: "SIGTERM" }
    : { code: 0, signal: null };
  assert.deepEqual(await exited, expected);
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("mints an owner-only capability file from stdin and prints only its path", async () => {
  const monitorUrl = "https://watch-pr.example/monitor/opaque-capability-105";
  const mint = startMint(monitorUrl);

  try {
    assert.deepEqual(await mint.exited, { code: 0, signal: null });
    const urlFile = mint.stdout().trim();
    assert.equal(mint.stdout(), `${urlFile}\n`);
    const expectedDirectory = process.platform === "win32" ? realpathSync(tmpdir()) : temporaryDirectory;
    assert.equal(urlFile.startsWith(join(expectedDirectory, "watch-pr-monitor-")), true);
    if (process.platform !== "win32") {
      assert.equal(statSync(urlFile).mode & 0o777, 0o600);
    }
    assert.equal(readFileSync(urlFile, "utf8"), monitorUrl);
    assert.equal(await readMonitorUrlFile(urlFile), monitorUrl);
    assert.equal(existsSync(urlFile), false);
    assert.equal(mint.stderr(), "");
  } finally {
    if (mint.child.exitCode === null) mint.child.kill("SIGKILL");
  }
});

test("removes an unconsumed capability file when publishing the path fails", async () => {
  const mintDirectory = process.platform === "win32"
    ? undefined
    : mkdtempSync(join(tmpdir(), "watch-pr-monitor-mint-"));
  const before = process.platform === "win32" ? capabilityNames() : undefined;
  const monitorUrl = "https://watch-pr.example/monitor/opaque-capability-105";
  const childArgs = [
    "--input-type=module",
    "-e",
    `import { mintFromStdin } from ${JSON.stringify(pathToFileURL(watcherPath).href)};
process.stdout.write = (_chunk, encoding, callback) => {
  const done = typeof encoding === "function" ? encoding : callback;
  const error = new Error("stdout closed");
  done?.(error);
  process.stdout.emit("error", error);
  return false;
};
try {
  await mintFromStdin(process.argv[1]);
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}`,
  ];
  if (mintDirectory !== undefined) childArgs.push(mintDirectory);
  const child = spawn(process.execPath, childArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));
  child.stdin.write(`${monitorUrl}\n`);

  try {
    assert.deepEqual(await exited, { code: 1, signal: null });
    assert.equal(stdout, "");
    assert.match(stderr, /stdout closed/);
    if (mintDirectory === undefined) {
      assert.deepEqual(capabilityNames(), before);
    } else {
      assert.deepEqual(readdirSync(mintDirectory), []);
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    if (mintDirectory !== undefined) rmSync(mintDirectory, { recursive: true, force: true });
  }
});

test("removes the capability file when cancellation races publication", async () => {
  const mintDirectory = process.platform === "win32"
    ? undefined
    : mkdtempSync(join(tmpdir(), "watch-pr-monitor-cancel-"));
  const before = process.platform === "win32" ? capabilityNames() : undefined;
  const monitorUrl = "https://watch-pr.example/monitor/opaque-capability-105";
  const childArgs = [
    "--input-type=module",
    "-e",
    `import { mintFromStdin } from ${JSON.stringify(pathToFileURL(watcherPath).href)};
process.stdout.write = (_chunk, encoding, callback) => {
  const done = typeof encoding === "function" ? encoding : callback;
  process.emit("SIGTERM");
  done?.();
  return false;
};
try {
  await mintFromStdin(process.argv[1]);
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}`,
  ];
  if (mintDirectory !== undefined) childArgs.push(mintDirectory);
  const child = spawn(process.execPath, childArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));
  child.stdin.write(`${monitorUrl}\n`);

  try {
    assert.deepEqual(await exited, { code: 1, signal: null });
    assert.equal(stdout, "");
    assert.match(stderr, /monitor URL minting was cancelled/);
    if (mintDirectory === undefined) {
      assert.deepEqual(capabilityNames(), before);
    } else {
      assert.deepEqual(readdirSync(mintDirectory), []);
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    if (mintDirectory !== undefined) rmSync(mintDirectory, { recursive: true, force: true });
  }
});

test("rejects empty mint input without printing a capability path", async () => {
  const mint = startMint("\n");

  assert.deepEqual(await mint.exited, { code: 1, signal: null });
  assert.equal(mint.stdout(), "");
  assert.match(mint.stderr(), /monitor URL from stdin was empty/);
});

test("rejects a relative mint directory", async () => {
  const mint = startMint("https://watch-pr.example/monitor/capability", ".");

  assert.deepEqual(await mint.exited, { code: 1, signal: null });
  assert.equal(mint.stdout(), "");
  assert.match(mint.stderr(), /directory must be an absolute path/);
});

test("rejects a mint directory inside the repository", async () => {
  const mint = startMint("https://watch-pr.example/monitor/capability", process.cwd());

  assert.deepEqual(await mint.exited, { code: 1, signal: null });
  assert.equal(mint.stdout(), "");
  assert.match(
    mint.stderr(),
    process.platform === "win32" ? /custom monitor URL file directories are not supported/ : /outside the repository/,
  );
});

test("rejects line breaks in a mint directory", async () => {
  const mint = startMint("https://watch-pr.example/monitor/capability", `${temporaryDirectory}\nunsafe`);

  assert.deepEqual(await mint.exited, { code: 1, signal: null });
  assert.equal(mint.stdout(), "");
  assert.match(mint.stderr(), /must not contain line breaks/);
});

test("prints readiness for a successful idle SSE response and stays alive", async () => {
  const { server, url } = await startServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.flushHeaders();
  });
  const watcher = startWatcher(url);

  try {
    await waitFor(() => watcher.stdout().includes("\n"), "the readiness record");
    assert.equal(watcher.child.exitCode, null);
    assert.equal(watcher.stdout(), "watch-pr: ready\n");
    assert.equal(existsSync(watcher.urlFile), false);

    watcher.child.kill("SIGTERM");
    await assertWatcherStoppedByTest(watcher.exited);
    assert.equal(watcher.stderr(), "");
  } finally {
    if (watcher.child.exitCode === null) watcher.child.kill("SIGKILL");
    await closeServer(server);
  }
});

test("prints readiness before the first PR event", async () => {
  const { server, url } = await startServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    sendEvent(response, monitorEvent("event-1"));
  });
  const watcher = startWatcher(url);

  try {
    await waitFor(() => watcher.stdout().includes("PR 42 updated: head"), "the intermediate event");
    assert.equal(watcher.child.exitCode, null);
    const output = watcher.stdout().trim().split("\n");
    assert.deepEqual(output, [
      "watch-pr: ready",
      "PR 42 updated: head",
    ]);

    watcher.child.kill("SIGTERM");
    await assertWatcherStoppedByTest(watcher.exited);
    assert.equal(watcher.stderr(), "");
  } finally {
    if (watcher.child.exitCode === null) watcher.child.kill("SIGKILL");
    await closeServer(server);
  }
});

test("falls back to the GitHub event when an update has no changed fields", async () => {
  const { server, url } = await startServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    sendEvent(response, monitorEvent("event-base-push", "watching", {
      githubEvent: "push",
      changes: [],
    }));
  });
  const watcher = startWatcher(url);

  try {
    await waitFor(() => watcher.stdout().includes("PR 42 updated: push"), "the push update");
    assert.equal(watcher.child.exitCode, null);
    assert.deepEqual(watcher.stdout().trim().split("\n"), [
      "watch-pr: ready",
      "PR 42 updated: push",
    ]);

    watcher.child.kill("SIGTERM");
    await assertWatcherStoppedByTest(watcher.exited);
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
    const output = watcher.stdout().trim().split("\n");
    assert.deepEqual(output, [
      "watch-pr: ready",
      "PR 42 updated: head",
      "PR 42 finished: CLOSED",
    ]);
    assert.equal(watcher.stderr(), "");
  } finally {
    if (watcher.child.exitCode === null) watcher.child.kill("SIGKILL");
    await closeServer(server);
  }
});

test("keeps one watcher alive from an intermediate event through terminal state", async () => {
  const { server, url } = await startServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    sendEvent(response, monitorEvent("event-intermediate"));
    setTimeout(() => {
      sendEvent(response, monitorEvent("event-terminal", "closed", {
        action: "closed",
        changes: ["lifecycle"],
      }));
    }, 50);
  });
  const watcher = startWatcher(url);

  try {
    await waitFor(() => watcher.stdout().includes("PR 42 updated: head"), "the intermediate event");
    assert.equal(watcher.child.exitCode, null);
    assert.deepEqual(await watcher.exited, { code: 0, signal: null });
    const output = watcher.stdout().trim().split("\n");
    assert.deepEqual(output, [
      "watch-pr: ready",
      "PR 42 updated: head",
      "PR 42 finished: CLOSED",
    ]);
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
    const output = watcher.stdout().trim().split("\n");
    assert.deepEqual(output, [
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

test("does not print readiness for a permanently invalid SSE response", async () => {
  let requests = 0;
  const { server, url } = await startServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  const watcher = startWatcher(url);

  try {
    assert.deepEqual(await watcher.exited, { code: 1, signal: null });
    assert.equal(requests, 1);
    assert.equal(watcher.stdout(), "");
    assert.match(watcher.stderr(), /expected text\/event-stream/);
  } finally {
    if (watcher.child.exitCode === null) watcher.child.kill("SIGKILL");
    await closeServer(server);
  }
});

test("rejects a monitor URL file with group or other access", {
  skip: process.platform === "win32",
}, async () => {
  const watcher = startWatcher("https://watch-pr.example/monitor/capability", {
    mode: 0o644,
  });

  assert.deepEqual(await watcher.exited, { code: 1, signal: null });
  assert.equal(watcher.stdout(), "");
  assert.match(watcher.stderr(), /permissions.*group or other access/);
  assert.equal(existsSync(watcher.urlFile), true);
});

test("reports a missing monitor URL file without exposing a capability", async () => {
  const watcher = startWatcher("", { createUrlFile: false });

  assert.deepEqual(await watcher.exited, { code: 1, signal: null });
  assert.equal(watcher.stdout(), "");
  assert.match(watcher.stderr(), /could not open the monitor URL file/);
  assert.equal(existsSync(watcher.urlFile), false);
});

test("portable file opening rejects symlinks when O_NOFOLLOW is unavailable", async () => {
  const target = join(temporaryDirectory, `${urlFileSequence += 1}.target`);
  const link = join(temporaryDirectory, `${urlFileSequence += 1}.link`);
  writeFileSync(target, "https://watch-pr.example/monitor/capability", {
    encoding: "utf8",
    mode: 0o600,
  });
  symlinkSync(target, link);

  await assert.rejects(
    readMonitorUrlFile(link, { noFollowFlag: null }),
    /regular file, not a symbolic link/,
  );
  assert.equal(existsSync(target), true);
  assert.equal(existsSync(link), true);
});

test("portable file opening verifies and consumes a regular capability file", async () => {
  const urlFile = join(temporaryDirectory, `${urlFileSequence += 1}.portable`);
  const monitorUrl = "https://watch-pr.example/monitor/capability";
  writeFileSync(urlFile, monitorUrl, { encoding: "utf8", mode: 0o600 });

  await assert.doesNotReject(async () => {
    assert.equal(
      await readMonitorUrlFile(urlFile, { noFollowFlag: null }),
      monitorUrl,
    );
  });
  assert.equal(existsSync(urlFile), false);
});

test("rejects non-HTTP URLs even when their hostname is loopback", async () => {
  const watcher = startWatcher("file://localhost/monitor/test-capability");

  assert.deepEqual(await watcher.exited, { code: 1, signal: null });
  assert.equal(watcher.stdout(), "");
  assert.match(watcher.stderr(), /HTTPS or loopback HTTP/);
});
