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
  const rawComment = comment.replace(": Please", ": <!-- hidden\nmetadata -->Please");
  const { server, url } = await startServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    sendEvent(response, monitorEvent("event-comment", "watching", {
      githubEvent: "issue_comment",
      changes: ["comments"],
      details: [rawComment],
    }));
  });
  const watcher = startWatcher(url);

  try {
    await waitFor(() => watcher.stdout().includes(comment), "the comment event");
    assert.deepEqual(watcher.stdout().trim().split("\n"), [
      "watch-pr: ready",
      comment,
    ]);
    assert.equal(watcher.child.exitCode, null);
    await stopWatcher(watcher);
    assert.equal(watcher.stderr(), "");
  } finally {
    if (watcher.child.exitCode === null) watcher.child.kill("SIGKILL");
    await closeServer(server);
  }
});

test("strips Markdown HTML comments without deleting literal code forms", () => {
  const detail = [
    "comment #987 @reviewer: <!-- hidden metadata -->Keep",
    "`const marker = \"<!-- more -->\"`.",
    "",
    "    const indented = \"<!-- indented -->\";",
    "Escaped \\<!-- escaped -->.",
    "```html",
    "<!-- fenced example -->",
    "```",
  ].join("\n");

  assert.equal(
    formatMonitorEvent(monitorEvent("event-markdown-comment", "watching", {
      details: [detail],
    })),
    "comment #987 @reviewer: Keep `const marker = \"<!-- more -->\"`. const indented = \"<!-- indented -->\"; Escaped \\<!-- escaped -->. ```html <!-- fenced example --> ```",
  );

  assert.equal(
    formatMonitorEvent(monitorEvent("event-crlf-comment", "watching", {
      details: [
        "comment #988 @reviewer:\r\n```html\r\n<!-- visible source -->\r\n```\r\n<!-- hidden metadata -->Keep",
      ],
    })),
    "comment #988 @reviewer: ```html <!-- visible source --> ``` Keep",
  );
  assert.equal(
    formatMonitorEvent(monitorEvent("event-paragraph-comment", "watching", {
      details: ["comment #989 @reviewer: `first\n\n<!-- hidden metadata -->\n\nsecond`"],
    })),
    "comment #989 @reviewer: `first second`",
  );
  assert.equal(
    formatMonitorEvent(monitorEvent("event-invalid-fence", "watching", {
      details: ["comment #990 @reviewer:\n```a`b\n<!-- hidden metadata -->\nKeep"],
    })),
    "comment #990 @reviewer: ```a`b Keep",
  );
  assert.equal(
    formatMonitorEvent(monitorEvent("event-blockquote-fence", "watching", {
      details: [
        "comment #991 @reviewer:\n> ~~~html\n> <!-- blockquote source -->\n> ~~~\n<!-- hidden metadata -->Keep",
      ],
    })),
    "comment #991 @reviewer: > ~~~html > <!-- blockquote source --> > ~~~ Keep",
  );
  assert.equal(
    formatMonitorEvent(monitorEvent("event-list-fence", "watching", {
      details: [
        "comment #992 @reviewer:\n10. ```html\n    <!-- list source -->\n    ```\n<!-- hidden metadata -->Keep",
      ],
    })),
    "comment #992 @reviewer: 10. ```html <!-- list source --> ``` Keep",
  );
  assert.equal(
    formatMonitorEvent(monitorEvent("event-blockquote-indented", "watching", {
      details: [
        "comment #993 @reviewer:\n>     const marker = \"<!-- blockquote code -->\";\n<!-- hidden metadata -->Keep",
      ],
    })),
    "comment #993 @reviewer: > const marker = \"<!-- blockquote code -->\"; Keep",
  );
  assert.equal(
    formatMonitorEvent(monitorEvent("event-multiline-comment", "watching", {
      details: ["comment #994 @reviewer: <!-- first\n    -->visible <!-- hidden -->Keep"],
    })),
    "comment #994 @reviewer: visible Keep",
  );
  assert.equal(
    formatMonitorEvent(monitorEvent("event-unterminated-comment", "watching", {
      details: ["comment #995 @reviewer: visible <!-- hidden instruction"],
    })),
    "comment #995 @reviewer: visible",
  );
  assert.equal(
    formatMonitorEvent(monitorEvent("event-paragraph-indentation", "watching", {
      details: ["comment #996 @reviewer: paragraph\n    <!-- hidden -->Keep"],
    })),
    "comment #996 @reviewer: paragraph Keep",
  );
  assert.equal(
    formatMonitorEvent(monitorEvent("event-container-fence-end", "watching", {
      details: [
        "comment #999 @reviewer:\n> ```html\n> code\n<!-- hidden -->\n```\nKeep",
        "comment #1000 @reviewer:\n10. ```html\n    code\n<!-- hidden -->\n```\nKeep",
        "comment #1009 @reviewer:\n10. ```html\n    before\n\n    <!-- visible -->\n    ```\n<!-- hidden -->Keep",
      ],
    })),
    [
      "comment #999 @reviewer: > ```html > code ``` Keep",
      "comment #1000 @reviewer: 10. ```html code ``` Keep",
      "comment #1009 @reviewer: 10. ```html before <!-- visible --> ``` Keep",
    ].join("\n"),
  );
  assert.equal(
    formatMonitorEvent(monitorEvent("event-heading-indentation", "watching", {
      details: [
        "comment #1001 @reviewer:\n# Heading\n    const marker = \"<!-- visible -->\";\n<!-- hidden -->Keep",
      ],
    })),
    "comment #1001 @reviewer: # Heading const marker = \"<!-- visible -->\"; Keep",
  );
  assert.equal(
    formatMonitorEvent(monitorEvent("event-escaped-backticks", "watching", {
      details: ["comment #1002 @reviewer: \\`fake <!-- hidden -->\\` Keep"],
    })),
    "comment #1002 @reviewer: \\`fake \\` Keep",
  );
  assert.equal(
    formatMonitorEvent(monitorEvent("event-list-indentation", "watching", {
      details: [
        "comment #1003 @reviewer:\n- item\n\n    <!-- hidden -->Keep",
        "comment #1004 @reviewer:\n- item\n\n      const marker = \"<!-- visible -->\";",
        "comment #1005 @reviewer:\n-   item\n\n      <!-- hidden -->Keep",
        "comment #1006 @reviewer:\n-   item\n\n        const marker = \"<!-- visible -->\";",
        "comment #1007 @reviewer:\n-\titem\n\n      <!-- hidden -->Keep",
        "comment #1008 @reviewer:\n-\titem\n\n        const marker = \"<!-- visible -->\";",
        "comment #1010 @reviewer:\n-\n\n    <!-- hidden -->Keep",
        "comment #1011 @reviewer:\n-\n\n      const marker = \"<!-- visible -->\";",
      ],
    })),
    [
      "comment #1003 @reviewer: - item Keep",
      "comment #1004 @reviewer: - item const marker = \"<!-- visible -->\";",
      "comment #1005 @reviewer: - item Keep",
      "comment #1006 @reviewer: - item const marker = \"<!-- visible -->\";",
      "comment #1007 @reviewer: - item Keep",
      "comment #1008 @reviewer: - item const marker = \"<!-- visible -->\";",
      "comment #1010 @reviewer: - Keep",
      "comment #1011 @reviewer: - const marker = \"<!-- visible -->\";",
    ].join("\n"),
  );
});

test("prints each actionable category on its own line", () => {
  assert.equal(
    formatMonitorEvent(monitorEvent("event-categories", "watching", {
      details: [
        "comment #997 @reviewer: Do this | rebase: DIRTY",
        "checks: CI -> pass",
        "mergeability: CLEAN",
      ],
    })),
    [
      "comment #997 @reviewer: Do this | rebase: DIRTY",
      "checks: CI -> pass",
      "mergeability: CLEAN",
    ].join("\n"),
  );
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
  const oscLine = formatMonitorEvent(monitorEvent("event-osc", "watching", {
    details: [
      `comment #998 @reviewer: \u001b]0;first\u001b\\visible\u001b]0;second\u001b\\kept`,
    ],
  }));
  assert.equal(oscLine, "comment #998 @reviewer: visiblekept");
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
      "checks: all terminal (pass: 8, fail: 0, skipping: 0, cancel: 0)",
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
  const requestUrls = [];
  let connection = 0;
  const { server, url } = await startServer((request, response) => {
    requestHeaders.push(request.headers);
    requestUrls.push(request.url);
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
    assert.deepEqual(requestUrls, [
      "/monitor/transcript-safe-capability",
      "/monitor/transcript-safe-capability",
    ]);
    assert.equal(requestHeaders[0]["last-event-id"], "initial-cursor");
    assert.equal(requestHeaders[1]["last-event-id"], "event-1");
    assert.deepEqual(watcher.stdout().trim().split("\n"), [
      "watch-pr: ready",
      "checks: rerun started (pending: CI, Lint)",
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
      "checks: rerun started (pending: CI)",
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
