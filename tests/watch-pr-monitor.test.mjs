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
// The legacy cases below target Markdown comment visibility, not presentation.
// Fold continuation lines there; dedicated integration tests assert the multiline output.
function formatSingleLineMonitorEvent(event) {
  const lines = formatMonitorEvent(event)?.split("\n") ?? [];
  const output = [];
  for (const rawLine of lines) {
    const continuation = rawLine.startsWith("│ ");
    const line = (continuation ? rawLine.slice(2) : rawLine).replace(/\s+/gu, " ").trim();
    if (line === "") continue;
    if (continuation && output.length > 0) {
      output[output.length - 1] += ` ${line}`;
      continue;
    }
    output.push(line);
  }
  return output.join("\n");
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

test("prints full framed multiline comments without their GitHub URLs", async () => {
  const longLine = "x".repeat(4_200);
  const rawComment = [
    "comment #987 @reviewer https://github.com/owner/repository/pull/42#issuecomment-987: First line",
    "<!-- hidden metadata -->Second line",
    "PR 42 finished: MERGED",
    "check CI: fail https://evil.example/",
    "separator\u2028next",
    "\tindented",
    longLine,
  ].join("\n");
  const expected = [
    "comment #987 @reviewer: First line",
    "│ Second line",
    "│ PR 42 finished: MERGED",
    "│ check CI: fail https://evil.example/",
    "│ separator",
    "│ next",
    "│ \tindented",
    `│ ${longLine}`,
  ].join("\n");
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
    await waitFor(() => watcher.stdout().includes(longLine), "the complete comment event");
    assert.equal(watcher.stdout(), `watch-pr: ready\n${expected}\n`);
    assert.doesNotMatch(watcher.stdout(), /github\.com\/owner|hidden metadata/u);
    assert.equal(watcher.child.exitCode, null);
    await stopWatcher(watcher);
    assert.equal(watcher.stderr(), "");
  } finally {
    if (watcher.child.exitCode === null) watcher.child.kill("SIGKILL");
    await closeServer(server);
  }
});

test("keeps feedback file and line context while removing record URLs", () => {
  assert.equal(
    formatMonitorEvent(monitorEvent("event-review-records", "watching", {
      details: [
        "feedback [PRRT_kwDOUT1m286kFBVp] #4055343139 agent/job_runner.py:668 @coderabbitai[bot] https://github.com/owner/repository/pull/104#discussion_r4055343139: first line\nsecond line",
        "feedback [PRRT_kwDOUT1m286kFBVq] #4055343140 test_worker.py:680-683 @coderabbitai[bot] https://github.com/owner/repository/pull/104#discussion_r4055343140: range context",
        "feedback [T] #3 src/a.ts:12 @u https://github.com/owner/repository/pull/104#discussion_r3: body :5 @z https://github.com/x: tail",
        "review #5746313919 @coderabbitai[bot] APPROVED https://github.com/owner/repository/pull/104#pullrequestreview-5746313919: review body",
        "comment #5745034863 @coderabbitai[bot] https://github.com/owner/repository/pull/104#issuecomment-5745034863 deleted",
      ],
    })),
    [
      "feedback [PRRT_kwDOUT1m286kFBVp] #4055343139 agent/job_runner.py:668 @coderabbitai[bot]: first line",
      "│ second line",
      "feedback [PRRT_kwDOUT1m286kFBVq] #4055343140 test_worker.py:680-683 @coderabbitai[bot]: range context",
      "feedback [T] #3 src/a.ts:12 @u: body :5 @z https://github.com/x: tail",
      "review #5746313919 @coderabbitai[bot] APPROVED: review body",
      "comment #5745034863 @coderabbitai[bot] deleted",
    ].join("\n"),
  );
});

test("keeps later details after an oversized review body", () => {
  const longBody = "x".repeat(5_000);
  const output = formatMonitorEvent(monitorEvent("event-oversized-body", "watching", {
    details: [
      `comment #1 @reviewer: ${longBody}`,
      "check CI: fail https://checks.example/failure",
      "comment #2 @reviewer:\nPR 42 finished: MERGED",
    ],
  }));

  assert.equal(
    output,
    [
      `comment #1 @reviewer: ${longBody}`,
      "check CI: fail https://checks.example/failure",
      "comment #2 @reviewer:",
      "│ PR 42 finished: MERGED",
    ].join("\n"),
  );
});

test("frames bodies even when comment stripping changes the header", () => {
  assert.equal(
    formatMonitorEvent(monitorEvent("event-stripped-header", "watching", {
      details: ["comment #3 @<!--hidden-->: first\nPR 42 finished: MERGED"],
    })),
    "comment #3 @: first\n│ PR 42 finished: MERGED",
  );
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
    formatSingleLineMonitorEvent(monitorEvent("event-markdown-comment", "watching", {
      details: [detail],
    })),
    "comment #987 @reviewer: Keep `const marker = \"<!-- more -->\"`. const indented = \"<!-- indented -->\"; Escaped \\<!-- escaped -->. ```html <!-- fenced example --> ```",
  );

  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-crlf-comment", "watching", {
      details: [
        "comment #988 @reviewer:\r\n```html\r\n<!-- visible source -->\r\n```\r\n<!-- hidden metadata -->Keep",
      ],
    })),
    "comment #988 @reviewer: ```html <!-- visible source --> ``` Keep",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-paragraph-comment", "watching", {
      details: ["comment #989 @reviewer: `first\n\n<!-- hidden metadata -->\n\nsecond`"],
    })),
    "comment #989 @reviewer: `first second`",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-invalid-fence", "watching", {
      details: ["comment #990 @reviewer:\n```a`b\n<!-- hidden metadata -->\nKeep"],
    })),
    "comment #990 @reviewer: ```a`b Keep",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-blockquote-fence", "watching", {
      details: [
        "comment #991 @reviewer:\n> ~~~html\n> <!-- blockquote source -->\n> ~~~\n<!-- hidden metadata -->Keep",
      ],
    })),
    "comment #991 @reviewer: > ~~~html > <!-- blockquote source --> > ~~~ Keep",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-comment-container-exit", "watching", {
      details: [
        "comment #1051 @reviewer:\n> <!-- hidden\nroot -->\n    <!-- hidden instruction -->Keep",
      ],
    })),
    "comment #1051 @reviewer: > root --> Keep",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-list-fence", "watching", {
      details: [
        "comment #992 @reviewer:\n10. ```html\n    <!-- list source -->\n    ```\n<!-- hidden metadata -->Keep",
      ],
    })),
    "comment #992 @reviewer: 10. ```html <!-- list source --> ``` Keep",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-tabbed-list-fence", "watching", {
      details: [
        "comment #992 @reviewer:\n-\t```html\n    ```\n    <!-- hidden instruction -->",
      ],
    })),
    "comment #992 @reviewer: - ```html ```\n+1 more changes",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-tabbed-closing-fence", "watching", {
      details: [
        "comment #1052 @reviewer:\n-\t```html\n\tcode\n\t```\n\t<!-- hidden instruction -->Keep",
      ],
    })),
    "comment #1052 @reviewer: - ```html code ``` Keep\n+1 more changes",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-list-relative-fence-close", "watching", {
      details: [
        "comment #1054 @reviewer:\n- ```html\n  code\n     ```\n  <!-- hidden instruction -->Keep",
      ],
    })),
    "comment #1054 @reviewer: - ```html code ``` Keep",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-inherited-list-fence", "watching", {
      details: [
        "comment #992 @reviewer:\n- item\n\n  ```html\nroot\n<!-- hidden instruction -->",
      ],
    })),
    "comment #992 @reviewer: - item ```html root",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-blockquote-indented", "watching", {
      details: [
        "comment #993 @reviewer:\n>     const marker = \"<!-- blockquote code -->\";\n<!-- hidden metadata -->Keep",
      ],
    })),
    "comment #993 @reviewer: > const marker = \"<!-- blockquote code -->\"; Keep",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-multiline-comment", "watching", {
      details: ["comment #994 @reviewer: <!-- first\n    -->visible <!-- hidden -->Keep"],
    })),
    "comment #994 @reviewer: visible Keep",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-html-comment-closing-context", "watching", {
      details: [
        "comment #1053 @reviewer:\n<!-- hidden\n--> ```\n<!-- hidden instruction -->\n``` ",
      ],
    })),
    "comment #1053 @reviewer: ``` ```",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-unterminated-comment", "watching", {
      details: ["comment #995 @reviewer: visible <!-- hidden instruction"],
    })),
    "comment #995 @reviewer: visible",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-paragraph-indentation", "watching", {
      details: ["comment #996 @reviewer: paragraph\n    <!-- hidden -->Keep"],
    })),
    "comment #996 @reviewer: paragraph Keep",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-container-fence-end", "watching", {
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
    formatSingleLineMonitorEvent(monitorEvent("event-heading-indentation", "watching", {
      details: [
        "comment #1001 @reviewer:\n# Heading\n    const marker = \"<!-- visible -->\";\n<!-- hidden -->Keep",
      ],
    })),
    "comment #1001 @reviewer: # Heading const marker = \"<!-- visible -->\"; Keep",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-escaped-backticks", "watching", {
      details: ["comment #1002 @reviewer: \\`fake <!-- hidden -->\\` Keep"],
    })),
    "comment #1002 @reviewer: \\`fake \\` Keep",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-code-span-block-boundary", "watching", {
      details: ["comment #1002 @reviewer:\n> `fake\n# heading <!-- hidden instruction -->\n`close"],
    })),
    "comment #1002 @reviewer: > `fake # heading `close",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-heading-code-span-boundary", "watching", {
      details: ["comment #1002 @reviewer:\n# `fake <!-- hidden instruction -->\n`close"],
    })),
    "comment #1002 @reviewer: # `fake `close",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-html-code-span-boundary", "watching", {
      details: ["comment #1002 @reviewer:\n`fake\n<div><!-- hidden instruction -->\n`close"],
    })),
    "comment #1002 @reviewer: `fake <div> `close",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-inherited-list-code-span", "watching", {
      details: [
        "comment #1002 @reviewer:\n- item\n\n  `fake\nroot <!-- hidden instruction -->\n`close",
      ],
    })),
    "comment #1002 @reviewer: - item `fake root `close",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-blockquote-lazy-code-span", "watching", {
      details: [
        "comment #1059 @reviewer:\n> `foo\nbar <!-- visible -->\n` baz",
      ],
    })),
    "comment #1059 @reviewer: > `foo bar <!-- visible --> ` baz",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-inherited-list-html", "watching", {
      details: [
        "comment #1002 @reviewer:\n- item\n\n  <pre>\nroot\n\n    <!-- visible code -->",
      ],
    })),
    "comment #1002 @reviewer: - item <pre> root <!-- visible code -->",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-inherited-list-html-comment", "watching", {
      details: [
        "comment #1055 @reviewer:\n-   item\n\n    <!-- hidden\n# heading\n    <!-- visible -->",
      ],
    })),
    "comment #1055 @reviewer: - item # heading <!-- visible -->",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-inherited-list-html-comment-padding", "watching", {
      details: [
        "comment #1056 @reviewer:\n- item\n\n    <!-- hidden\n# heading\n    <!-- visible -->",
      ],
    })),
    "comment #1056 @reviewer: - item # heading <!-- visible -->",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-list-indentation", "watching", {
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
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-mixed-list-padding", "watching", {
      details: [
        "comment #1012 @reviewer:\n- \titem\n\n      <!-- hidden -->Keep",
        "comment #1013 @reviewer:\n- \titem\n\n        const marker = \"<!-- visible -->\";",
      ],
    })),
    [
      "comment #1012 @reviewer: - item Keep",
      "comment #1013 @reviewer: - item const marker = \"<!-- visible -->\";",
    ].join("\n"),
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-invalid-fence-predecessor", "watching", {
      details: ["comment #1014 @reviewer:\n```a`b\n    <!-- hidden -->\nKeep"],
    })),
    "comment #1014 @reviewer: ```a`b Keep",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-record-prefix-body", "watching", {
      details: [
        "comment #1015 @reviewer:     <!-- visible example -->",
        "review #1016 @reviewer APPROVED https://github.com/o/r/pull/1#r1:     <!-- visible example -->",
        "feedback [PRRT_1] #1017 src/index.ts:12 @reviewer:     <!-- visible example -->",
        "feedback [PRRT_2] #1018 docs/my file.md:12 @reviewer:     <!-- visible example -->",
        "feedback [PRRT_3] #1019 docs @fake: name.md:12 @reviewer https://github.com/o/r/pull/1#discussion_r1:     <!-- visible example -->",
        "comment #1018 @reviewer: paragraph\n    <!-- hidden -->Keep",
      ],
    })),
    [
      "comment #1015 @reviewer: <!-- visible example -->",
      "review #1016 @reviewer APPROVED: <!-- visible example -->",
      "feedback [PRRT_1] #1017 src/index.ts:12 @reviewer: <!-- visible example -->",
      "feedback [PRRT_2] #1018 docs/my file.md:12 @reviewer: <!-- visible example -->",
      "feedback [PRRT_3] #1019 docs @fake: name.md:12 @reviewer: <!-- visible example -->",
      "comment #1018 @reviewer: paragraph Keep",
    ].join("\n"),
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-setext-underline-context", "watching", {
      details: [
        "comment #1019 @reviewer:\n===\n    <!-- hidden -->Keep",
        "comment #1020 @reviewer:\n# Heading\n===\n    <!-- hidden -->Keep",
        "comment #1021 @reviewer:\nTitle\n===\n    const marker = \"<!-- visible -->\";",
        "comment #1022 @reviewer:\n---\n    const marker = \"<!-- visible -->\";",
      ],
    })),
    [
      "comment #1019 @reviewer: === Keep",
      "comment #1020 @reviewer: # Heading === Keep",
      "comment #1021 @reviewer: Title === const marker = \"<!-- visible -->\";",
      "comment #1022 @reviewer: --- const marker = \"<!-- visible -->\";",
    ].join("\n"),
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-list-interruption", "watching", {
      details: [
        "comment #1023 @reviewer:\nparagraph\n2.     <!-- hidden -->Keep",
        "comment #1024 @reviewer:\nparagraph\n1.     const marker = \"<!-- visible -->\";",
        "comment #1025 @reviewer:\nparagraph\n-     const marker = \"<!-- visible -->\";",
      ],
    })),
    [
      "comment #1023 @reviewer: paragraph 2. Keep",
      "comment #1024 @reviewer: paragraph 1. const marker = \"<!-- visible -->\";",
      "comment #1025 @reviewer: paragraph - const marker = \"<!-- visible -->\";",
    ].join("\n"),
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-lazy-marker-state", "watching", {
      details: [
        "comment #1026 @reviewer:\nparagraph\n2.     <!-- hidden -->X\n1.     const marker = \"<!-- visible -->\";",
        "comment #1027 @reviewer:\nparagraph\n2. text\n\n    const marker = \"<!-- visible -->\";",
        "comment #1028 @reviewer:\nparagraph\n-\n      <!-- hidden -->Keep",
      ],
    })),
    [
      "comment #1026 @reviewer: paragraph 2. X 1. const marker = \"<!-- visible -->\";",
      "comment #1027 @reviewer: paragraph 2. text const marker = \"<!-- visible -->\";",
      "comment #1028 @reviewer: paragraph - Keep",
    ].join("\n"),
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-html-comment-block", "watching", {
      details: [
        "comment #1029 @reviewer:\n<!-- hidden block -->\n    <!-- visible code -->",
        "comment #1030 @reviewer:\n<!-- hidden\nblock -->\n    <!-- visible code -->",
        "comment #1031 @reviewer:\n<!-- hidden\nblock --> tail\n    <!-- visible code -->",
        "comment #1032 @reviewer:\nparagraph <!-- hidden -->\n    <!-- hidden too -->",
      ],
    })),
    [
      "comment #1029 @reviewer: <!-- visible code -->",
      "comment #1030 @reviewer: <!-- visible code -->",
      "comment #1031 @reviewer: tail <!-- visible code -->",
      "comment #1032 @reviewer: paragraph",
    ].join("\n"),
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-html-raw-blocks", "watching", {
      details: [
        "comment #1033 @reviewer:\n<pre>x</pre>\n    <!-- visible code -->",
        "comment #1034 @reviewer:\n<PRE>\nx\n</PrE>\n    <!-- visible code -->",
        "comment #1035 @reviewer:\n<?php\necho 1;\n?>\n    <!-- visible code -->",
        "comment #1036 @reviewer:\n<!DOCTYPE\nhtml>\n    <!-- visible code -->",
        "comment #1037 @reviewer:\n<![CDATA[\nx\n]]>\n    <!-- visible code -->",
        "comment #1038 @reviewer:\n<div>\ntext\n\n    <!-- visible code -->",
        "comment #1039 @reviewer:\n<pre>\n\n    <!-- hidden -->\n</pre>",
        "comment #1040 @reviewer:\nparagraph <pre>x</pre>\n    <!-- hidden -->",
        "comment #1050 @reviewer:\n<pre>\n```\n<!-- hidden instruction -->\n```\n</pre>",
      ],
    })),
    [
      "comment #1033 @reviewer: <pre>x</pre> <!-- visible code -->",
      "comment #1034 @reviewer: <PRE> x </PrE> <!-- visible code -->",
      "comment #1035 @reviewer: <?php echo 1; ?> <!-- visible code -->",
      "comment #1036 @reviewer: <!DOCTYPE html> <!-- visible code -->",
      "comment #1037 @reviewer: <![CDATA[ x ]]> <!-- visible code -->",
      "comment #1038 @reviewer: <div> text <!-- visible code -->",
      "comment #1039 @reviewer: <pre> </pre>",
      "comment #1040 @reviewer: paragraph <pre>x</pre>",
      "comment #1050 @reviewer: <pre> ``` ``` </pre>",
    ].join("\n"),
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-html-matching-raw-closer", "watching", {
      details: [
        "comment #1057 @reviewer:\n<pre>\n</script>\n```\n<!-- hidden -->Keep\n```\n</pre>",
      ],
    })),
    "comment #1057 @reviewer: <pre> </script> ``` Keep ``` </pre>",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-nested-raw-comment-closer", "watching", {
      details: [
        "comment #1060 @reviewer:\n<pre>\n<!-- x\n</pre> -->\n    <!-- visible -->",
      ],
    })),
    "comment #1060 @reviewer: <pre> <!-- visible -->",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-html-type7-attribute-grammar", "watching", {
      details: [
        "comment #1058 @reviewer:\n<x =>\n```\n<!-- hidden -->Keep\n```",
      ],
    })),
    "comment #1058 @reviewer: <x => ``` <!-- hidden -->Keep ```",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-html-type7-attribute-name", "watching", {
      details: [
        "comment #1 @a:\n<x @>\n```html\n<!-- visible example -->\n```",
      ],
    })),
    "comment #1 @a: <x @> ```html <!-- visible example --> ```",
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-html-block-scope", "watching", {
      details: [
        "comment #1041 @reviewer:\n<!foo>\n    <!-- hidden -->",
        "comment #1042 @reviewer:\n<!FOO>\n    <!-- visible code -->",
        "comment #1043 @reviewer:\n> <pre>x\n    <!-- visible code -->",
        "comment #1044 @reviewer:\n- <pre>x\nparagraph\n\n    <!-- visible code -->",
        "comment #1045 @reviewer:\n> <pre>x\n>     <!-- hidden -->",
      ],
    })),
    [
      "comment #1041 @reviewer: <!foo>",
      "comment #1042 @reviewer: <!FOO> <!-- visible code -->",
      "comment #1043 @reviewer: > <pre>x <!-- visible code -->",
      "comment #1044 @reviewer: - <pre>x paragraph <!-- visible code -->",
      "comment #1045 @reviewer: > <pre>x >",
    ].join("\n"),
  );
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-html-blank-closing-blocks", "watching", {
      details: [
        "comment #1046 @reviewer:\n<div>\n# heading\n    <!-- hidden -->",
        "comment #1047 @reviewer:\n</pre>\n# heading\n    <!-- hidden -->",
        "comment #1048 @reviewer:\n1. <pre>x\n> >     <!-- visible code -->",
        "comment #1049 @reviewer:\n- <pre>x\n  >     <!-- hidden -->",
      ],
    })),
    [
      "comment #1046 @reviewer: <div> # heading",
      "comment #1047 @reviewer: </pre> # heading",
      "comment #1048 @reviewer: 1. <pre>x > > <!-- visible code -->",
      "comment #1049 @reviewer: - <pre>x >",
    ].join("\n"),
  );
});

test("drops every comment and reports a detail whose block structure is undecidable", () => {
  const reconciled = formatSingleLineMonitorEvent(monitorEvent("event-ambiguous", "watching", {
    details: [
      // A quote left and re-entered around a lazily continued paragraph: the indented line
      // is either that paragraph or code inside the quote.
      "comment #1050 @reviewer:\n> text\n]]>\n>     <!-- hidden -->",
      // A type 7 opener under an open paragraph, which CommonMark forbids from starting a
      // block there and cmark-gfm honours inconsistently across container boundaries.
      "comment #1051 @reviewer:\ntext\n</pre>\n    <!-- hidden -->",
      // An unterminated comment in an undecidable detail loses its tail as well.
      "comment #1052 @reviewer:\n> text\n]]>\n>     <!-- hidden",
    ],
  }));

  assert.doesNotMatch(reconciled, /<!--|hidden/u);
  assert.equal(
    reconciled,
    [
      "comment #1050 @reviewer: > text ]]> >",
      "comment #1051 @reviewer: text </pre>",
      "comment #1052 @reviewer: > text ]]> >",
      "+3 more changes",
    ].join("\n"),
  );

  // Neighbouring shapes the scanner can still decide keep full fidelity and no marker.
  const decided = formatSingleLineMonitorEvent(monitorEvent("event-decidable", "watching", {
    details: [
      "comment #1053 @reviewer:\ntext\n\n</pre>\n    <!-- hidden -->",
      "comment #1054 @reviewer:\n> text\n\n    <!-- visible code -->",
      "comment #1055 @reviewer:\n- item\n\n      <!-- visible code -->",
    ],
  }));

  assert.equal(
    decided,
    [
      "comment #1053 @reviewer: text </pre>",
      "comment #1054 @reviewer: > text <!-- visible code -->",
      "comment #1055 @reviewer: - item <!-- visible code -->",
    ].join("\n"),
  );
});

test("prints each actionable category on its own line", () => {
  assert.equal(
    formatSingleLineMonitorEvent(monitorEvent("event-categories", "watching", {
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
  const line = formatSingleLineMonitorEvent(monitorEvent("event-checks", "watching", {
    details: Array.from(
      { length: 6 },
      (_, index) => `detail ${index} \u001b[2K${"x".repeat(2_000)}`,
    ),
  }));

  assert.ok(line.length <= 4_096);
  assert.doesNotMatch(line, /\u001b/u);
  const oscLine = formatSingleLineMonitorEvent(monitorEvent("event-osc", "watching", {
    details: [
      `comment #998 @reviewer: \u001b]0;first\u001b\\visible\u001b]0;second\u001b\\kept`,
    ],
  }));
  assert.equal(oscLine, "comment #998 @reviewer: visiblekept");
  assert.match(line, /\+8 more changes$/u);
  const markedLine = formatSingleLineMonitorEvent(monitorEvent("event-many-checks", "watching", {
    details: [
      ...Array.from({ length: 5 }, (_, index) => `check ${index}: ${"x".repeat(2_000)}`),
      "+7 more changes",
    ],
  }));
  assert.ok(markedLine.length <= 4_096);
  assert.match(markedLine, /\+13 more changes$/u);
  const unicodeLine = formatSingleLineMonitorEvent(monitorEvent("event-unicode", "watching", {
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
