#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 10_000;
const VALID_TERMINAL_STATES = new Set(["watching", "merged", "closed"]);
const READY_LINE = "watch-pr: ready";
const USAGE = "usage: node watch-pr-monitor.mjs <monitor-url>";

class PermanentMonitorError extends Error { }
const MAX_DETAIL_LENGTH = 1_000;
const MAX_UPDATE_OUTPUT_LENGTH = 4_096;
const CONTROL_CHARACTERS_RE = /[\u0000-\u001f\u007f-\u009f]/gu;
const ANSI_ESCAPE_SEQUENCE_RE = /\u001b(?:\](?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/gu;
const OVERFLOW_DETAIL_RE = /^\+(\d+) more changes$/u;

function permanent(message) {
  return new PermanentMonitorError(message);
}

function abortableDelay(milliseconds, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });

    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

async function* parseEventStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines = [];
  let eventName;
  let eventId;

  function dispatch() {
    if (dataLines.length === 0) {
      eventName = undefined;
      eventId = undefined;
      return undefined;
    }
    const frame = { event: eventName, id: eventId, data: dataLines.join("\n") };
    dataLines = [];
    eventName = undefined;
    eventId = undefined;
    return frame;
  }

  function consumeLine(rawLine) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") return dispatch();
    if (line.startsWith(":")) return undefined;

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") dataLines.push(value);
    else if (field === "event") eventName = value;
    else if (field === "id" && !value.includes("\0")) eventId = value;
    return undefined;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const frame = consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (frame) yield frame;
      }
    }
    buffer += decoder.decode();
    if (buffer !== "") consumeLine(buffer);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The connection may already have closed.
    }
    reader.releaseLock();
  }
}

function parseMonitorEvent(frame) {
  if (frame.event !== undefined && frame.event !== "pr") {
    throw permanent(`unexpected SSE event type ${JSON.stringify(frame.event)}`);
  }

  let event;
  try {
    event = JSON.parse(frame.data);
  } catch {
    throw permanent("received malformed JSON from the monitor feed");
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw permanent("received a non-object monitor event");
  }

  const payloadId = event.id === undefined ? undefined : String(event.id);
  const id = frame.id ?? payloadId;
  if (!id) throw permanent("received a monitor event without an event ID");
  if (frame.id !== undefined && payloadId !== undefined && frame.id !== payloadId) {
    throw permanent("received conflicting SSE and payload event IDs");
  }
  if (!VALID_TERMINAL_STATES.has(event.terminalState)) {
    throw permanent(`received invalid terminalState ${JSON.stringify(event.terminalState)}`);
  }

  return { event, id };
}

function truncate(value, maximumLength) {
  if (value.length <= maximumLength) return value;
  let prefix = value.slice(0, maximumLength - 1);
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) prefix = prefix.slice(0, -1);
  return `${prefix}…`;
}

function delimiterRunLength(value, index, delimiter) {
  let end = index;
  while (value[end] === delimiter) end += 1;
  return end - index;
}

function consumeContainerIndent(value, cursor, limit) {
  let spaces = 0;
  while (cursor < limit && spaces < 3 && value[cursor] === " ") {
    cursor += 1;
    spaces += 1;
  }
  return cursor;
}

function listMarkerEnd(value, cursor, limit) {
  if (
    (value[cursor] === "-" || value[cursor] === "+" || value[cursor] === "*") &&
    (value[cursor + 1] === " " || value[cursor + 1] === "\t")
  ) {
    return cursor + 2;
  }
  let marker = cursor;
  while (
    marker < limit &&
    marker - cursor < 9 &&
    value[marker] >= "0" &&
    value[marker] <= "9"
  ) marker += 1;
  if (
    marker === cursor ||
    (value[marker] !== "." && value[marker] !== ")") ||
    (value[marker + 1] !== " " && value[marker + 1] !== "\t")
  ) {
    return null;
  }
  return marker + 2;
}

function containerContentStart(value, lineStart, limit) {
  let cursor = lineStart;
  while (cursor < limit) {
    const marker = consumeContainerIndent(value, cursor, limit);
    if (value[marker] === ">") {
      cursor = marker + 1;
      if (value[cursor] === " " || value[cursor] === "\t") cursor += 1;
      continue;
    }
    const markerEnd = listMarkerEnd(value, marker, limit);
    if (markerEnd !== null) {
      cursor = markerEnd;
      continue;
    }
    break;
  }
  return cursor;
}

function isFencePosition(value, lineStart, index) {
  const contentStart = containerContentStart(value, lineStart, index);
  if (index - contentStart > 3) return false;
  for (let cursor = contentStart; cursor < index; cursor += 1) {
    if (value[cursor] !== " ") return false;
  }
  return true;
}

function isWhitespaceIndentWithin(value, lineStart, index, maximumIndent) {
  if (index - lineStart > maximumIndent) return false;
  for (let cursor = lineStart; cursor < index; cursor += 1) {
    if (value[cursor] !== " ") return false;
  }
  return true;
}

function closesFence(value, index, runLength) {
  let cursor = index + runLength;
  while (value[cursor] === " " || value[cursor] === "\t") cursor += 1;
  return (
    cursor === value.length ||
    value[cursor] === "\n" ||
    value[cursor] === "\r"
  );
}

function isEscaped(value, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isIndentedCodeLine(value, lineStart, activeListIndent = 0) {
  let indentation = 0;
  const contentStart = containerContentStart(value, lineStart, value.length);
  for (let cursor = contentStart; cursor < value.length; cursor += 1) {
    if (value[cursor] === " ") {
      indentation += 1;
      continue;
    }
    if (value[cursor] === "\t") {
      indentation += 4 - (indentation % 4);
      continue;
    }
    break;
  }
  const explicitListIndent = listContentIndent(value, lineStart, value.length);
  const baseIndent = explicitListIndent ?? (activeListIndent || contentStart - lineStart);
  return contentStart - lineStart + indentation >= baseIndent + 4;
}

function containerDepth(value, lineStart, limit) {
  let cursor = lineStart;
  let depth = 0;
  while (cursor < limit) {
    const marker = consumeContainerIndent(value, cursor, limit);
    if (value[marker] === ">") {
      cursor = marker + 1;
      if (value[cursor] === " " || value[cursor] === "\t") cursor += 1;
      depth += 1;
      continue;
    }
    const markerEnd = listMarkerEnd(value, marker, limit);
    if (markerEnd === null) break;
    cursor = markerEnd;
    depth += 1;
  }
  return depth;
}

function containerQuoteDepth(value, lineStart, limit) {
  let cursor = lineStart;
  let depth = 0;
  while (cursor < limit) {
    const marker = consumeContainerIndent(value, cursor, limit);
    if (value[marker] === ">") {
      cursor = marker + 1;
      if (value[cursor] === " " || value[cursor] === "\t") cursor += 1;
      depth += 1;
      continue;
    }
    const markerEnd = listMarkerEnd(value, marker, limit);
    if (markerEnd === null) break;
    cursor = markerEnd;
  }
  return depth;
}

function containerExtent(value, lineStart) {
  let cursor = containerContentStart(value, lineStart, value.length);
  let column = cursor - lineStart;
  while (value[cursor] === " " || value[cursor] === "\t") {
    if (value[cursor] === " ") column += 1;
    else column += 4 - (column % 4);
    cursor += 1;
  }
  return column;
}

function listContentIndent(value, lineStart, limit) {
  const depth = containerDepth(value, lineStart, limit);
  if (depth === containerQuoteDepth(value, lineStart, limit)) return null;
  return containerContentStart(value, lineStart, limit) - lineStart;
}

function lineEnd(value, lineStart) {
  const newline = value.indexOf("\n", lineStart);
  return newline === -1 ? value.length : newline;
}

function isBlankMarkdownLine(value, lineStart, lineEnd) {
  let cursor = containerContentStart(value, lineStart, lineEnd);
  while (
    cursor < lineEnd &&
    (value[cursor] === " " || value[cursor] === "\t" || value[cursor] === "\r")
  ) cursor += 1;
  return cursor === lineEnd;
}

function startsNonParagraphBlock(value, lineStart, lineEnd) {
  if (isBlankMarkdownLine(value, lineStart, lineEnd)) return true;
  let cursor = containerContentStart(value, lineStart, lineEnd);
  cursor = consumeContainerIndent(value, cursor, lineEnd);
  const line = value.slice(cursor, lineEnd).replace(/\r$/u, "");
  if (/^#{1,6}(?:[ \t]|$)/u.test(line)) return true;
  if (/^(?:`{3,}|~{3,})/u.test(line)) return true;
  if (/^(?:=+|-+)[ \t]*$/u.test(line)) return true;
  return /^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/u.test(line);
}

function listIndentForNextLine(
  value,
  previousLineStart,
  previousLineEnd,
  nextLineStart,
  activeListIndent,
) {
  const indent = listContentIndent(value, previousLineStart, previousLineEnd) ?? activeListIndent;
  const nextLineEnd = lineEnd(value, nextLineStart);
  const nextExplicitIndent = listContentIndent(value, nextLineStart, nextLineEnd);
  if (nextExplicitIndent !== null) return nextExplicitIndent;
  if (isBlankMarkdownLine(value, nextLineStart, nextLineEnd)) return indent;
  if (indent > 0 && containerExtent(value, nextLineStart) >= indent) return indent;
  return 0;
}

function startsIndentedCodeLine(
  value,
  lineStart,
  previousLineStart,
  previousLineEnd,
  previousLineWasIndentedCode,
  activeListIndent,
) {
  if (!isIndentedCodeLine(value, lineStart, activeListIndent)) return false;
  if (previousLineWasIndentedCode) return true;
  if (startsNonParagraphBlock(value, previousLineStart, previousLineEnd)) return true;
  return (
    containerDepth(value, lineStart, value.length) >
    containerDepth(value, previousLineStart, previousLineEnd)
  );
}

function continuesFenceContainer(
  value,
  lineStart,
  quoteDepth,
  listDepth,
  containerIndent,
) {
  const nextQuoteDepth = containerQuoteDepth(value, lineStart, value.length);
  if (nextQuoteDepth < quoteDepth) return false;
  if (listDepth === 0) return true;
  const depth = containerDepth(value, lineStart, value.length);
  if (depth - nextQuoteDepth >= listDepth) return true;
  return containerExtent(value, lineStart) >= containerIndent;
}

function validFenceOpener(value, index, runLength, delimiter) {
  if (delimiter !== "`") return true;
  for (let cursor = index + runLength; cursor < value.length; cursor += 1) {
    if (value[cursor] === "\n" || value[cursor] === "\r") return true;
    if (value[cursor] === "`") return false;
  }
  return true;
}

function blankLineFollows(value, newlineIndex) {
  let cursor = newlineIndex + 1;
  while (value[cursor] === " " || value[cursor] === "\t") cursor += 1;
  if (value[cursor] === "\r") cursor += 1;
  return value[cursor] === "\n";
}

function hasClosingInlineDelimiter(value, index, runLength) {
  let cursor = index;
  while (cursor < value.length) {
    if (value[cursor] === "\n" && blankLineFollows(value, cursor)) return false;
    if (value[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    const candidateLength = delimiterRunLength(value, cursor, "`");
    if (candidateLength === runLength) return true;
    cursor += candidateLength;
  }
  return false;
}

function stripMarkdownHtmlComments(value) {
  let result = "";
  let cursor = 0;
  let lineStart = 0;
  let activeListIndent = listContentIndent(value, lineStart, lineEnd(value, lineStart)) ?? 0;
  let indentedCodeLine = isIndentedCodeLine(value, lineStart, activeListIndent);
  let fenceDelimiter;
  let fenceLength = 0;
  let fenceIndentLimit = 3;
  let fenceQuoteDepth = 0;
  let fenceListDepth = 0;
  let fenceContainerIndent = 0;
  let inlineLength = 0;

  while (cursor < value.length) {
    const character = value[cursor];
    if (fenceDelimiter) {
      if (character === fenceDelimiter) {
        const runLength = delimiterRunLength(value, cursor, fenceDelimiter);
        result += value.slice(cursor, cursor + runLength);
        cursor += runLength;
        const runStart = cursor - runLength;
        if (
          runLength >= fenceLength &&
          (
            isFencePosition(value, lineStart, runStart) ||
            isWhitespaceIndentWithin(value, lineStart, runStart, fenceIndentLimit)
          ) &&
          closesFence(value, runStart, runLength)
        ) {
          fenceDelimiter = undefined;
          fenceLength = 0;
          fenceIndentLimit = 3;
          fenceQuoteDepth = 0;
          fenceListDepth = 0;
          fenceContainerIndent = 0;
        }
        continue;
      }
      result += character;
      cursor += 1;
      if (character === "\n") {
        const nextLineStart = cursor;
        activeListIndent = listIndentForNextLine(
          value,
          lineStart,
          cursor - 1,
          nextLineStart,
          activeListIndent,
        );
        indentedCodeLine = startsIndentedCodeLine(
          value,
          nextLineStart,
          lineStart,
          cursor - 1,
          indentedCodeLine,
          activeListIndent,
        );
        if (
          fenceDelimiter &&
          !continuesFenceContainer(
            value,
            nextLineStart,
            fenceQuoteDepth,
            fenceListDepth,
            fenceContainerIndent,
          )
        ) {
          fenceDelimiter = undefined;
          fenceLength = 0;
          fenceIndentLimit = 3;
          fenceQuoteDepth = 0;
          fenceListDepth = 0;
          fenceContainerIndent = 0;
        }
        lineStart = nextLineStart;
      }
      continue;
    }

    if (inlineLength > 0) {
      if (character === "`") {
        const runLength = delimiterRunLength(value, cursor, "`");
        result += value.slice(cursor, cursor + runLength);
        cursor += runLength;
        if (runLength === inlineLength) inlineLength = 0;
        continue;
      }
      result += character;
      cursor += 1;
      if (character === "\n") {
        const nextLineStart = cursor;
        activeListIndent = listIndentForNextLine(
          value,
          lineStart,
          cursor - 1,
          nextLineStart,
          activeListIndent,
        );
        indentedCodeLine = startsIndentedCodeLine(
          value,
          nextLineStart,
          lineStart,
          cursor - 1,
          indentedCodeLine,
          activeListIndent,
        );
        lineStart = nextLineStart;
      }
      continue;
    }

    if (character === "`" || character === "~") {
      const runLength = delimiterRunLength(value, cursor, character);
      const escapedDelimiter = isEscaped(value, cursor);
      if (
        !escapedDelimiter &&
        runLength >= 3 &&
        isFencePosition(value, lineStart, cursor) &&
        validFenceOpener(value, cursor, runLength, character)
      ) {
        fenceDelimiter = character;
        fenceLength = runLength;
        const openingDepth = containerDepth(value, lineStart, cursor);
        fenceQuoteDepth = containerQuoteDepth(value, lineStart, cursor);
        fenceListDepth = openingDepth - fenceQuoteDepth;
        fenceContainerIndent = cursor - lineStart;
        fenceIndentLimit = Math.max(3, cursor - lineStart);
      } else if (
        !escapedDelimiter &&
        character === "`" &&
        hasClosingInlineDelimiter(value, cursor + runLength, runLength)
      ) {
        inlineLength = runLength;
      }
      result += value.slice(cursor, cursor + runLength);
      cursor += runLength;
      continue;
    }

    if (
      value.startsWith("<!--", cursor) &&
      !isEscaped(value, cursor) &&
      !indentedCodeLine
    ) {
      const commentEnd = value.indexOf("-->", cursor + 4);
      if (commentEnd === -1) {
        cursor = value.length;
        continue;
      }
      const nextCursor = commentEnd + 3;
      if (value.lastIndexOf("\n", nextCursor - 1) >= cursor) {
        lineStart = nextCursor;
        indentedCodeLine = false;
      }
      cursor = nextCursor;
      continue;
    }

    result += character;
    cursor += 1;
    if (character === "\n") {
      const nextLineStart = cursor;
      activeListIndent = listIndentForNextLine(
        value,
        lineStart,
        cursor - 1,
        nextLineStart,
        activeListIndent,
      );
      indentedCodeLine = startsIndentedCodeLine(
        value,
        nextLineStart,
        lineStart,
        cursor - 1,
        indentedCodeLine,
        activeListIndent,
      );
      lineStart = nextLineStart;
    }
  }
  return result;
}

function compactDetail(detail) {
  const value = stripMarkdownHtmlComments(detail.replace(ANSI_ESCAPE_SEQUENCE_RE, ""))
    .replace(/\s+/gu, " ")
    .replace(CONTROL_CHARACTERS_RE, "")
    .trim();
  return {
    value: truncate(value, MAX_DETAIL_LENGTH),
    truncated: value.length > MAX_DETAIL_LENGTH,
  };
}

export function formatMonitorEvent(event) {
  if (!Number.isInteger(event.pullRequestNumber) || event.pullRequestNumber <= 0) {
    throw permanent("received an invalid pull request number");
  }

  if (event.terminalState === "merged" || event.terminalState === "closed") {
    return `PR ${event.pullRequestNumber} finished: ${event.terminalState.toUpperCase()}`;
  }

  if (!Array.isArray(event.details) || event.details.some((detail) => typeof detail !== "string")) {
    throw permanent("received invalid monitor event details");
  }
  const compactedDetails = event.details.map(compactDetail);
  const details = [...new Set(compactedDetails.map((detail) => detail.value))].filter(Boolean);
  if (details.length === 0) return null;

  const actionable = [];
  let omitted = compactedDetails.filter((detail) => detail.truncated).length;
  for (const detail of details) {
    const match = OVERFLOW_DETAIL_RE.exec(detail);
    const count = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(count) || count < 0) {
      actionable.push(detail);
      continue;
    }
    omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + count);
  }

  const included = [];
  for (const detail of actionable) {
    const omittedAfterDetail = omitted + actionable.length - included.length - 1;
    const parts = [...included, detail];
    if (omittedAfterDetail > 0) parts.push(`+${omittedAfterDetail} more changes`);
    if (parts.join("\n").length > MAX_UPDATE_OUTPUT_LENGTH) break;
    included.push(detail);
  }
  omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + actionable.length - included.length);
  if (omitted > 0) included.push(`+${omitted} more changes`);
  if (included.length === 0) return null;
  return included.join("\n");
}

function validateResponse(response, { readyEmitted, cursor }) {
  if ([401, 403, 404].includes(response.status)) {
    if (!readyEmitted) {
      throw permanent(
        `monitor URL was rejected with HTTP ${response.status} before readiness; return to the root session and call unwatch_pr`,
      );
    }
    throw permanent(
      `monitor URL was rejected with HTTP ${response.status} after readiness; last event id ${JSON.stringify(cursor ?? "")}; return to the root session, call open_pr_monitor once, and resume from that event id`,
    );
  }
  if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
    throw permanent(
      `monitor request failed permanently with HTTP ${response.status}; return to the root session and call unwatch_pr`,
    );
  }
  if (response.status >= 300 && response.status < 400) {
    throw permanent(`monitor endpoint returned an unexpected HTTP ${response.status} redirect`);
  }
  if (!response.ok) return false;

  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "text/event-stream") {
    throw permanent(`monitor endpoint returned ${contentType || "no content type"}, expected text/event-stream`);
  }
  if (!response.body) throw permanent("monitor endpoint returned no response body");
  return true;
}

export async function watchPrMonitor(monitorUrl, { signal, fetchImpl = fetch } = {}) {
  let parsedUrl;
  try {
    parsedUrl = new URL(monitorUrl);
  } catch {
    throw permanent("monitor URL is invalid");
  }
  const isHttps = parsedUrl.protocol === "https:";
  const isLoopbackHttp = parsedUrl.protocol === "http:" && (
    parsedUrl.hostname === "127.0.0.1" ||
    parsedUrl.hostname === "localhost" ||
    parsedUrl.hostname === "[::1]"
  );
  if (!isHttps && !isLoopbackHttp) {
    throw permanent("monitor URL must use HTTPS or loopback HTTP");
  }

  const effectiveSignal = signal ?? new AbortController().signal;
  let cursor = parsedUrl.searchParams.get("cursor") || undefined;
  if (cursor !== undefined) {
    if (cursor.length > 256) throw permanent("monitor URL cursor exceeds 256 characters");
    try {
      new Headers({ "Last-Event-ID": cursor });
    } catch {
      throw permanent("monitor URL cursor is not a valid Last-Event-ID");
    }
  }
  parsedUrl.searchParams.delete("cursor");
  let lastPrintedId;
  let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  let readyEmitted = false;

  while (!effectiveSignal.aborted) {
    let response;
    try {
      response = await fetchImpl(parsedUrl, {
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          ...(cursor === undefined ? {} : { "Last-Event-ID": cursor }),
        },
        redirect: "manual",
        signal: effectiveSignal,
      });
    } catch (error) {
      if (effectiveSignal.aborted) return;
      if (error instanceof PermanentMonitorError) throw error;
      await abortableDelay(reconnectDelay, effectiveSignal);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      continue;
    }

    let receivedEvent = false;
    try {
      if (!validateResponse(response, { readyEmitted, cursor })) {
        await response.body?.cancel();
      } else {
        if (!readyEmitted) {
          process.stdout.write(`${READY_LINE}\n`);
          readyEmitted = true;
        }
        for await (const frame of parseEventStream(response.body)) {
          const parsed = parseMonitorEvent(frame);
          cursor = parsed.id;
          receivedEvent = true;
          reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
          if (parsed.id === lastPrintedId) continue;

          const line = formatMonitorEvent(parsed.event);
          lastPrintedId = parsed.id;
          if (line) process.stdout.write(`${line}\n`);
          if (parsed.event.terminalState === "merged" || parsed.event.terminalState === "closed") return;
        }
      }
    } catch (error) {
      if (effectiveSignal.aborted) return;
      if (error instanceof PermanentMonitorError) throw error;
      // A dropped response is transient. Reconnect from the last complete event.
    }

    if (effectiveSignal.aborted) return;
    await abortableDelay(reconnectDelay, effectiveSignal);
    if (!receivedEvent) reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw permanent(USAGE);

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await watchPrMonitor(args[0], { signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`watch-pr monitor: ${message}\n`);
    process.exitCode = 1;
  });
}
