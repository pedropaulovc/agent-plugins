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
const ATX_HEADING_RE = /^#{1,6}(?:[ \t]|$)/u;
const SETEXT_UNDERLINE_RE = /^(?:=+|-+)[ \t]*$/u;
const THEMATIC_BREAK_RE = /^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/u;
// Deterministic backend record prefixes (`comment`/`review`/`feedback`) that precede a
// Markdown body: the body always follows the `:` that closes the structured header.
const DETAIL_BODY_PREFIX_RES = [
  /^comment #\d+ @[^\s:]+(?: \S+)?:\s/u,
  /^review #\d+ @[^\s:]+ [^\s:]+(?: \S+)?:\s/u,
  /^feedback \[[^\]\s]*\] #\d+(?: .+:\d+(?:-\d+)?)? @[^\s:]+(?: https:\/\/github\.com\/\S+)?:\s/u,
];
const DETAIL_URL_RES = [
  /^(comment #\d+ @[^\s:]+) https:\/\/github\.com\/\S+(?=:\s| deleted$)/u,
  /^(review #\d+ @[^\s:]+ [^\s:]+) https:\/\/github\.com\/\S+(?=:\s| deleted$)/u,
  /^(feedback \[[^\]\s]*\] #\d+(?: .+:\d+(?:-\d+)?)? @[^\s:]+) https:\/\/github\.com\/\S+(?=:\s| deleted$)/u,
];

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

function listPaddingEnd(value, start, limit, markerColumn) {
  let end = start;
  let column = markerColumn;
  while (end < limit && column - markerColumn < 5) {
    if (value[end] === " ") column += 1;
    else if (value[end] === "\t") column += 4 - (column % 4);
    else break;
    end += 1;
  }
  if (column - markerColumn <= 4) return { end, column };
  return { end: start + 1, column: markerColumn + 1 };
}

function listMarkerEnd(value, cursor, limit, column) {
  let marker = cursor;
  if (value[cursor] === "-" || value[cursor] === "+" || value[cursor] === "*") {
    marker = cursor + 1;
  } else {
    while (
      marker < limit &&
      marker - cursor < 9 &&
      value[marker] >= "0" &&
      value[marker] <= "9"
    ) marker += 1;
    if (
      marker === cursor ||
      (value[marker] !== "." && value[marker] !== ")")
    ) {
      return null;
    }
    marker += 1;
  }
  const markerColumn = column + (marker - cursor);
  if (marker >= limit) return { end: limit, column: markerColumn };
  if (value[marker] !== " " && value[marker] !== "\t") return null;
  return listPaddingEnd(value, marker, limit, markerColumn);
}

function scanContainers(value, lineStart, limit) {
  let cursor = lineStart;
  let column = 0;
  let depth = 0;
  let quoteDepth = 0;
  while (cursor < limit) {
    const markerStart = consumeContainerIndent(value, cursor, limit);
    const markerColumn = column + (markerStart - cursor);
    if (markerStart < limit && value[markerStart] === ">") {
      cursor = markerStart + 1;
      column = markerColumn + 1;
      if (cursor < limit && value[cursor] === " ") {
        cursor += 1;
        column += 1;
      } else if (cursor < limit && value[cursor] === "\t") {
        column += 4 - (column % 4);
        cursor += 1;
      }
      depth += 1;
      quoteDepth += 1;
      continue;
    }
    const marker = markerStart < limit
      ? listMarkerEnd(value, markerStart, limit, markerColumn)
      : null;
    if (marker === null) break;
    cursor = marker.end;
    column = marker.column;
    depth += 1;
  }
  return { contentStart: cursor, column, depth, quoteDepth };
}

function containerContentStart(value, lineStart, limit) {
  return scanContainers(value, lineStart, limit).contentStart;
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
  if (visualColumn(value, lineStart, index) > maximumIndent) return false;
  for (let cursor = lineStart; cursor < index; cursor += 1) {
    if (value[cursor] !== " " && value[cursor] !== "\t") return false;
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

function visualColumn(value, start, end) {
  let column = 0;
  for (let cursor = start; cursor < end; cursor += 1) {
    if (value[cursor] === "\t") column += 4 - (column % 4);
    else column += 1;
  }
  return column;
}

function isIndentedCodeLine(value, lineStart, activeListIndent = 0) {
  const { contentStart, column: contentColumn } = scanContainers(value, lineStart, value.length);
  let column = contentColumn;
  for (let cursor = contentStart; cursor < value.length; cursor += 1) {
    if (value[cursor] === " ") {
      column += 1;
      continue;
    }
    if (value[cursor] === "\t") {
      column += 4 - (column % 4);
      continue;
    }
    break;
  }
  const explicitListIndent = listContentIndent(value, lineStart, value.length);
  const baseIndent = explicitListIndent ?? (activeListIndent || contentColumn);
  return column >= baseIndent + 4;
}

function containerDepth(value, lineStart, limit) {
  return scanContainers(value, lineStart, limit).depth;
}

function containerQuoteDepth(value, lineStart, limit) {
  return scanContainers(value, lineStart, limit).quoteDepth;
}

function containerExtent(value, lineStart) {
  const { contentStart, column } = scanContainers(value, lineStart, value.length);
  let cursor = contentStart;
  let extent = column;
  while (value[cursor] === " " || value[cursor] === "\t") {
    if (value[cursor] === " ") extent += 1;
    else extent += 4 - (extent % 4);
    cursor += 1;
  }
  return extent;
}

// Visual column of the first non-space character, counted before any container marker is
// consumed, which is where the line sits relative to an enclosing list item's content.
function leadingIndentColumn(value, lineStart) {
  let cursor = lineStart;
  let column = 0;
  while (value[cursor] === " " || value[cursor] === "\t") {
    column += value[cursor] === " " ? 1 : 4 - (column % 4);
    cursor += 1;
  }
  return column;
}

function listContentIndent(value, lineStart, limit) {
  const { contentStart, column, depth, quoteDepth } = scanContainers(value, lineStart, limit);
  if (depth === quoteDepth) return null;
  const finalMarker = value[contentStart - 1];
  const virtualPadding = contentStart === limit &&
    (finalMarker === "-" || finalMarker === "+" || finalMarker === "*" ||
      finalMarker === "." || finalMarker === ")")
    ? 1
    : 0;
  return column + virtualPadding;
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

function blockContentStart(value, lineStart, lineEnd) {
  const cursor = containerContentStart(value, lineStart, lineEnd);
  return consumeContainerIndent(value, cursor, lineEnd);
}

function opensFence(value, cursor) {
  const delimiter = value[cursor];
  if (delimiter !== "`" && delimiter !== "~") return false;
  const runLength = delimiterRunLength(value, cursor, delimiter);
  return runLength >= 3 && validFenceOpener(value, cursor, runLength, delimiter);
}

// CommonMark HTML blocks. Types 1 to 5 close on a token: raw text elements, comments,
// processing instructions, declarations and CDATA. Types 6 and 7 close on a blank line and
// swallow every line until then, so a comment on one of those lines is hidden too.
//
// Type 7 is the one kind CommonMark forbids from interrupting a paragraph. This scanner
// opens it anyway, because guarding on the previous line either misreads laziness across a
// container boundary or costs a walk back to the start of the document; `interrupts: false`
// marks the case so a type 7 opener under an open paragraph reconciles the detail instead
// of silently choosing a reading.
const HTML_BLOCK_TAG_NAMES =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|" +
  "details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|" +
  "h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|" +
  "noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|" +
  "thead|title|tr|track|ul";
const HTML_TYPE_7_OPEN_RE =
  /^(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'=<>`]+))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*\r?$/u;
const HTML_BLOCK_KINDS = [
  { open: /^<script(?:[ \t\r>]|$)/iu, close: /<\/script>/iu },
  { open: /^<pre(?:[ \t\r>]|$)/iu, close: /<\/pre>/iu },
  { open: /^<style(?:[ \t\r>]|$)/iu, close: /<\/style>/iu },
  { open: /^<textarea(?:[ \t\r>]|$)/iu, close: /<\/textarea>/iu },
  { open: /^<!--/u, close: /-->/u },
  { open: /^<\?/u, close: /\?>/u },
  // cmark-gfm, the renderer GitHub uses, keeps the original declaration rule: `<!` plus an
  // uppercase ASCII letter. `<!foo>` stays paragraph text, so its continuation stays hidden.
  { open: /^<![A-Z]/u, close: />/u },
  { open: /^<!\[CDATA\[/u, close: /\]\]>/u },
  { open: new RegExp(`^</?(?:${HTML_BLOCK_TAG_NAMES})(?:[ \t\r>]|/>|$)`, "iu"), close: null },
  { open: HTML_TYPE_7_OPEN_RE, close: null, interrupts: false },
];

function htmlBlockKindAt(value, lineStart, lineEnd) {
  const blockStart = blockContentStart(value, lineStart, lineEnd);
  if (value[blockStart] !== "<" || isIndentedCodeLine(value, lineStart)) return null;
  const line = value.slice(blockStart, lineEnd);
  for (const kind of HTML_BLOCK_KINDS) {
    const opener = kind.open.exec(line);
    if (opener) return { kind, blockStart, contentStart: blockStart + opener[0].length };
  }
  return null;
}

// An inline `<pre>` or `<!--` later in a line leaves the paragraph open, and an opener whose
// closing token lands on a later line keeps the block open across the lines in between.
function completesHtmlBlock(value, lineStart, lineEnd) {
  const opened = htmlBlockKindAt(value, lineStart, lineEnd);
  if (!opened || !opened.kind.close) return false;
  return opened.kind.close.test(value.slice(opened.contentStart, lineEnd));
}

// Sentinel distinguishing "this line closed the block" from "no block is open".
const HTML_BLOCK_CLOSED = { closed: true };

function advanceHtmlBlockState(value, lineStart, lineEnd, openHtmlBlock) {
  if (openHtmlBlock) {
    const ends = openHtmlBlock.kind.close
      ? openHtmlBlock.kind.close.test(value.slice(lineStart, lineEnd))
      : isBlankMarkdownLine(value, lineStart, lineEnd);
    return ends ? HTML_BLOCK_CLOSED : openHtmlBlock;
  }
  const opened = htmlBlockKindAt(value, lineStart, lineEnd);
  if (!opened) return null;
  if (opened.kind.close && opened.kind.close.test(value.slice(opened.contentStart, lineEnd))) {
    return HTML_BLOCK_CLOSED;
  }
  return opened;
}

function isParagraphContentLine(value, lineStart, lineEnd) {
  if (isBlankMarkdownLine(value, lineStart, lineEnd)) return false;
  if (isIndentedCodeLine(value, lineStart)) return false;
  const cursor = blockContentStart(value, lineStart, lineEnd);
  if (opensFence(value, cursor)) return false;
  // Any raw block opener ends the paragraph, whether or not its closing token is on the
  // line: the lines that follow belong to the block and cannot be lazily continued.
  if (htmlBlockKindAt(value, lineStart, lineEnd) !== null) return false;
  const line = value.slice(cursor, lineEnd).replace(/\r$/u, "");
  return !ATX_HEADING_RE.test(line) &&
    !THEMATIC_BREAK_RE.test(line) &&
    !SETEXT_UNDERLINE_RE.test(line);
}

function previousLineStartOf(value, lineStart) {
  if (lineStart === 0) return -1;
  // `lastIndexOf` clamps a negative start to 0, so an empty leading line needs its own exit.
  if (lineStart === 1) return 0;
  return value.lastIndexOf("\n", lineStart - 2) + 1;
}

// A setext underline exists only under an open paragraph; a `===` run that opens a
// document, or follows a blank line or another block, is ordinary paragraph text.
function followsParagraphContent(value, lineStart) {
  const previousStart = previousLineStartOf(value, lineStart);
  if (previousStart < 0) return false;
  return isParagraphContentLine(value, previousStart, lineStart - 1);
}

function startsNonParagraphBlock(value, lineStart, lineEnd) {
  // A lazy marker line is paragraph text, even when the marker consumes the whole line.
  if (isLazyListContinuation(value, lineStart, lineEnd)) return false;
  if (isBlankMarkdownLine(value, lineStart, lineEnd)) return true;
  const cursor = blockContentStart(value, lineStart, lineEnd);
  if (opensFence(value, cursor)) return true;
  const htmlBlock = htmlBlockKindAt(value, lineStart, lineEnd);
  if ((htmlBlock && htmlBlock.kind.interrupts !== false) || completesHtmlBlock(value, lineStart, lineEnd)) {
    return true;
  }
  const line = value.slice(cursor, lineEnd).replace(/\r$/u, "");
  if (ATX_HEADING_RE.test(line) || THEMATIC_BREAK_RE.test(line)) return true;
  return SETEXT_UNDERLINE_RE.test(line) && followsParagraphContent(value, lineStart);
}

function listIndentForNextLine(
  value,
  previousLineStart,
  previousLineEnd,
  nextLineStart,
  activeListIndent,
) {
  const indent = establishedListContentIndent(value, previousLineStart, previousLineEnd) ??
    activeListIndent;
  const nextLineEnd = lineEnd(value, nextLineStart);
  const nextExplicitIndent = establishedListContentIndent(value, nextLineStart, nextLineEnd);
  if (nextExplicitIndent !== null) return nextExplicitIndent;
  if (isBlankMarkdownLine(value, nextLineStart, nextLineEnd)) return indent;
  // A list indent only carries into lines of the same block quote context; entering or
  // leaving a quote starts a different container, whose own markers set the indent.
  if (
    containerQuoteDepth(value, nextLineStart, nextLineEnd) !==
    containerQuoteDepth(value, previousLineStart, previousLineEnd)
  ) {
    return 0;
  }
  if (indent > 0 && containerExtent(value, nextLineStart) >= indent) return indent;
  return 0;
}

// CommonMark only lets a container interrupt an open paragraph when it is a block quote,
// a non-empty bullet item, or a non-empty ordered item numbered 1; anything else is a
// lazy continuation of that paragraph.
function interruptsParagraph(value, lineStart, limit) {
  const markerStart = consumeContainerIndent(value, lineStart, limit);
  if (markerStart >= limit) return false;
  if (value[markerStart] === ">") return true;
  const marker = listMarkerEnd(value, markerStart, limit, 0);
  if (marker === null) return true;
  if (value[markerStart] >= "0" && value[markerStart] <= "9") {
    let digitsEnd = markerStart;
    while (value[digitsEnd] >= "0" && value[digitsEnd] <= "9") digitsEnd += 1;
    if (Number(value.slice(markerStart, digitsEnd)) !== 1) return false;
  }
  let cursor = marker.end;
  while (
    cursor < limit &&
    (value[cursor] === " " || value[cursor] === "\t" || value[cursor] === "\r")
  ) cursor += 1;
  return cursor < limit;
}

// A marker line that cannot interrupt the paragraph above it (`2.` after body text) is
// lazy paragraph text, so it establishes neither list indentation nor container depth.
function isLazyListContinuation(value, lineStart, limit) {
  if (containerDepth(value, lineStart, limit) === 0) return false;
  if (interruptsParagraph(value, lineStart, limit)) return false;
  return followsParagraphContent(value, lineStart);
}

function establishedListContentIndent(value, lineStart, limit) {
  if (isLazyListContinuation(value, lineStart, limit)) return null;
  return listContentIndent(value, lineStart, limit);
}

// The container that owns the paragraph left open by this line. A lazy continuation drops
// container markers without opening anything (root-level text under a blockquote, or a `2.`
// marker that cannot interrupt), so the paragraph still belongs to the line that began it.
// `floor` is the first line the scanner knows is outside any raw HTML block: lines before it
// are block markup that only looks like paragraph text.
function openParagraphContainer(value, lineStart, limit, floor) {
  let start = lineStart;
  let end = limit;
  if (isLazyListContinuation(value, start, end)) {
    end = start - 1;
    start = previousLineStartOf(value, start);
  }
  let quoteDepth = containerQuoteDepth(value, start, end);
  let listDepth = containerDepth(value, start, end) - quoteDepth;
  while (isParagraphContentLine(value, start, end)) {
    const previousStart = previousLineStartOf(value, start);
    if (previousStart < floor) break;
    const previousEnd = start - 1;
    if (!isParagraphContentLine(value, previousStart, previousEnd)) break;
    const previousQuoteDepth = containerQuoteDepth(value, previousStart, previousEnd);
    const previousListDepth = containerDepth(value, previousStart, previousEnd) - previousQuoteDepth;
    // Adding a marker of either kind opens a new container instead of continuing lazily.
    if (quoteDepth > previousQuoteDepth || listDepth > previousListDepth) break;
    quoteDepth = previousQuoteDepth;
    listDepth = previousListDepth;
    start = previousStart;
    end = previousEnd;
  }
  return { quoteDepth, listDepth };
}

function startsIndentedCodeLine(
  value,
  lineStart,
  previousLineStart,
  previousLineEnd,
  previousLineWasIndentedCode,
  activeListIndent,
  previousLineEndedHtmlBlock,
  paragraphFloor,
) {
  if (!isIndentedCodeLine(value, lineStart, activeListIndent)) return false;
  if (previousLineWasIndentedCode) return true;
  // A multi-line comment block closes on a line whose remaining text carries no opener, so
  // the scanner reports that end explicitly; line-local predicates cover the single-line form.
  if (previousLineEndedHtmlBlock) return true;
  if (startsNonParagraphBlock(value, previousLineStart, previousLineEnd)) return true;
  // The guards above leave an open paragraph, so this line only begins an indented code
  // block when it opens a container of its own that may interrupt that paragraph. Quotes and
  // lists are compared separately: equal totals can still be two different containers.
  const openContainer = openParagraphContainer(
    value,
    previousLineStart,
    previousLineEnd,
    paragraphFloor,
  );
  const quoteDepth = containerQuoteDepth(value, lineStart, value.length);
  const listDepth = containerDepth(value, lineStart, value.length) - quoteDepth;
  if (quoteDepth <= openContainer.quoteDepth && listDepth <= openContainer.listDepth) {
    return false;
  }
  return interruptsParagraph(value, lineStart, lineEnd(value, lineStart));
}

// Which container owns an indented line decides whether it is code, where a comment is
// literal text, or paragraph continuation, where GitHub hides it. That call is only
// locally evident while the surrounding lines sit in the same container: once the quote
// depth changes, or a list indent reaches the line through a marker-less continuation,
// this scanner can land on either side. Such a detail is reconciled rather than trusted.
function indentedLineIsAmbiguous(
  value,
  lineStart,
  previousLineStart,
  previousLineEnd,
  lastContentStart,
  lastContentEnd,
  activeListIndent,
) {
  // Indentation measured against the line's own markers only: an inherited list indent is
  // exactly the quantity in doubt, so it cannot gate the question.
  if (!isIndentedCodeLine(value, lineStart, 0)) return false;
  // A blank line closes any paragraph above it, so nothing can be lazily continued across
  // it; only an enclosing list item, whose indent survives the blank, keeps the question
  // open.
  const afterBlankLine = previousLineStart >= 0 &&
    isBlankMarkdownLine(value, previousLineStart, previousLineEnd);
  if (afterBlankLine && activeListIndent === 0) return false;
  // Blank lines carry no container of their own, so the comparison uses the last line that
  // did. A quote opened or left between the two leaves both readings of this line live,
  // but only while that line could have left a paragraph open: block markup could not, and
  // a type 7 opener is the one kind whose own opening is already in doubt.
  if (lastContentStart >= 0) {
    const lastKind = htmlBlockKindAt(value, lastContentStart, lastContentEnd);
    if (
      (lastKind === null || lastKind.kind.interrupts === false) &&
      !startsNonParagraphBlock(value, lastContentStart, lastContentEnd) &&
      containerQuoteDepth(value, lineStart, lineEnd(value, lineStart)) !==
        containerQuoteDepth(value, lastContentStart, lastContentEnd)
    ) {
      return true;
    }
  }
  if (previousLineStart < 0) return false;
  // A blank line inside a list item restates nothing but ends nothing either: the indent
  // in force is still the item's own, so the inheritance question below is already settled.
  if (afterBlankLine || activeListIndent === 0) return false;
  // A line carrying its own list marker fixes the indent it is measured against, so its
  // content needs no inherited context to classify.
  if (establishedListContentIndent(value, lineStart, lineEnd(value, lineStart)) !== null) {
    return false;
  }
  return establishedListContentIndent(value, previousLineStart, previousLineEnd) === null;
}

// Shared by fenced code and raw HTML blocks: both end where their opening container ends.
function continuesOpeningContainer(
  value,
  lineStart,
  quoteDepth,
  listDepth,
  containerIndent,
) {
  const nextQuoteDepth = containerQuoteDepth(value, lineStart, value.length);
  if (nextQuoteDepth < quoteDepth) return false;
  if (listDepth === 0) return true;
  if (isBlankMarkdownLine(value, lineStart, lineEnd(value, lineStart))) return true;
  // A quote marker the block was not already inside starts a container of its own, so the
  // list item only survives when that marker is indented into the item's content column.
  // `containerExtent` cannot answer this: it measures the column after the markers.
  if (nextQuoteDepth > quoteDepth) return leadingIndentColumn(value, lineStart) >= containerIndent;
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

function hasClosingInlineDelimiter(
  value,
  index,
  runLength,
  openingLineStart,
  openingListIndent,
) {
  const openingLineEnd = lineEnd(value, openingLineStart);
  const openingCanContinue = !startsNonParagraphBlock(
    value,
    openingLineStart,
    openingLineEnd,
  );
  const openingDepth = containerDepth(value, openingLineStart, openingLineEnd);
  const openingQuoteDepth = containerQuoteDepth(value, openingLineStart, openingLineEnd);
  const openingListDepth = Math.max(
    openingDepth - openingQuoteDepth,
    openingListIndent > 0 ? 1 : 0,
  );
  let cursor = index;
  while (cursor < value.length) {
    if (value[cursor] === "\n") {
      if (!openingCanContinue) return false;
      if (blankLineFollows(value, cursor)) return false;
      const nextLineStart = cursor + 1;
      const nextLineEnd = lineEnd(value, nextLineStart);
      const nextDepth = containerDepth(value, nextLineStart, nextLineEnd);
      const nextQuoteDepth = containerQuoteDepth(value, nextLineStart, nextLineEnd);
      const continuesContainer = continuesOpeningContainer(
        value,
        nextLineStart,
        openingQuoteDepth,
        openingListDepth,
        openingListIndent,
      );
      const continuesLazyParagraph = !continuesContainer &&
        openingQuoteDepth > 0 &&
        openingListDepth === 0 &&
        isParagraphContentLine(value, nextLineStart, nextLineEnd) &&
        nextDepth <= openingDepth &&
        nextQuoteDepth <= openingQuoteDepth;
      if (!continuesContainer && !continuesLazyParagraph) return false;
      if (startsNonParagraphBlock(value, nextLineStart, nextLineEnd)) return false;
      const nextListIndent = establishedListContentIndent(value, nextLineStart, nextLineEnd);
      if (nextListIndent !== null && interruptsParagraph(value, nextLineStart, nextLineEnd)) {
        return false;
      }
      if (
        nextDepth > 0 &&
        (nextDepth !== openingDepth || nextQuoteDepth !== openingQuoteDepth) &&
        interruptsParagraph(value, nextLineStart, nextLineEnd)
      ) {
        return false;
      }
    }
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
function scanHtmlCommentEndWithinContainer(
  value,
  commentStart,
  openingLineStart,
  openingListIndent,
) {
  const commentEnd = value.indexOf("-->", commentStart + 4);
  const openingDepth = containerDepth(value, openingLineStart, commentStart);
  const openingQuoteDepth = containerQuoteDepth(value, openingLineStart, commentStart);
  const openingListDepth = Math.max(
    openingDepth - openingQuoteDepth,
    openingListIndent > 0 ? 1 : 0,
  );
  const openingContainerIndent = openingListIndent > 0
    ? openingListIndent
    : visualColumn(value, openingLineStart, commentStart);
  let scanLineStart = openingLineStart;
  while (true) {
    const newline = value.indexOf("\n", scanLineStart);
    if (newline === -1 || (commentEnd !== -1 && newline >= commentEnd)) {
      return { end: commentEnd, crossedContainer: false };
    }
    const nextLineStart = newline + 1;
    if (
      !continuesOpeningContainer(
        value,
        nextLineStart,
        openingQuoteDepth,
        openingListDepth,
        openingContainerIndent,
      )
    ) {
      return { end: newline, crossedContainer: true };
    }
    scanLineStart = nextLineStart;
  }
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
  // Raw HTML block state carried across lines: `openHtmlBlock` holds the kind whose closing
  // token has not been seen yet, together with the container it opened in, and
  // `htmlBlockEndsLine` marks the line that closes a block, which the newline handlers
  // consume so the next line may start an indented code block.
  let openHtmlBlock = null;
  let htmlQuoteDepth = 0;
  let htmlListDepth = 0;
  let htmlContainerIndent = 0;
  let htmlBlockEndsLine = false;
  // First line known to sit outside every raw HTML block; paragraph lookback stops here.
  let paragraphFloor = 0;
  // Set when a line's block type cannot be decided from the text alone. The caller then
  // drops every comment in the detail and reports it as unreconciled.
  let ambiguous = false;
  // Last line that carried content, so container comparisons can see past blank lines.
  let lastContentStart = -1;
  let lastContentEnd = -1;

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
        if (!isBlankMarkdownLine(value, lineStart, cursor - 1)) {
          lastContentStart = lineStart;
          lastContentEnd = cursor - 1;
        }
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
          htmlBlockEndsLine,
          paragraphFloor,
        );
        htmlBlockEndsLine = false;
        if (
          fenceDelimiter &&
          !continuesOpeningContainer(
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
        if (!isBlankMarkdownLine(value, lineStart, cursor - 1)) {
          lastContentStart = lineStart;
          lastContentEnd = cursor - 1;
        }
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
          htmlBlockEndsLine,
          paragraphFloor,
        );
        htmlBlockEndsLine = false;
        lineStart = nextLineStart;
      }
      continue;
    }

    if (!openHtmlBlock && (character === "`" || character === "~")) {
      const runLength = delimiterRunLength(value, cursor, character);
      const escapedDelimiter = isEscaped(value, cursor);
      if (
        !escapedDelimiter &&
        !htmlBlockEndsLine &&
        runLength >= 3 &&
        isFencePosition(value, lineStart, cursor) &&
        validFenceOpener(value, cursor, runLength, character)
      ) {
        fenceDelimiter = character;
        fenceLength = runLength;
        const openingDepth = containerDepth(value, lineStart, cursor);
        fenceQuoteDepth = containerQuoteDepth(value, lineStart, cursor);
        fenceListDepth = Math.max(
          openingDepth - fenceQuoteDepth,
          activeListIndent > 0 ? 1 : 0,
        );
        fenceContainerIndent = Math.max(
          visualColumn(value, lineStart, cursor),
          activeListIndent,
        );
        // A closer may sit three visual columns into an enclosing list item's content.
        fenceIndentLimit = fenceListDepth > 0
          ? fenceContainerIndent + 3
          : 3;
      } else if (
        !htmlBlockEndsLine &&
        !escapedDelimiter &&
        character === "`" &&
        hasClosingInlineDelimiter(
          value,
          cursor + runLength,
          runLength,
          lineStart,
          activeListIndent,
        )
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
      const leadingIndent = leadingIndentColumn(value, lineStart);
      const commentColumn = visualColumn(value, lineStart, cursor);
      const blockLevel = cursor === blockContentStart(value, lineStart, lineEnd(value, lineStart)) ||
        (
          activeListIndent > 0 &&
          commentColumn === leadingIndent &&
          leadingIndent >= activeListIndent &&
          leadingIndent <= activeListIndent + 3
        );
      let commentEnd = value.indexOf("-->", cursor + 4);
      let crossedContainer = false;
      if (blockLevel) {
        const scanned = scanHtmlCommentEndWithinContainer(
          value,
          cursor,
          lineStart,
          activeListIndent,
        );
        commentEnd = scanned.end;
        crossedContainer = scanned.crossedContainer;
      }
      if (crossedContainer) {
        // A block-level comment cannot consume lines after its quote/list container ends.
        // Leave that newline for the normal line transition so the outer container is
        // classified before the following text is scanned.
        htmlBlockEndsLine = true;
        cursor = commentEnd;
        continue;
      }
      if (commentEnd === -1) {
        cursor = value.length;
        continue;
      }
      const nextCursor = commentEnd + 3;
      const closesOuterHtmlBlock = Boolean(
        openHtmlBlock?.kind.close &&
        openHtmlBlock.kind.close.test(value.slice(cursor, nextCursor))
      );
      if (value.lastIndexOf("\n", nextCursor - 1) >= cursor) {
        lineStart = nextCursor;
        indentedCodeLine = false;
      }
      if (closesOuterHtmlBlock) {
        openHtmlBlock = null;
        htmlQuoteDepth = 0;
        htmlListDepth = 0;
        htmlContainerIndent = 0;
        htmlBlockEndsLine = true;
      }
      // A comment nested in an already open raw block normally does not end that block;
      // a matching closer carried inside the skipped span is handled above.
      if (blockLevel && !openHtmlBlock) htmlBlockEndsLine = true;
      cursor = nextCursor;
      continue;
    }

    result += character;
    cursor += 1;
    if (character === "\n") {
      const nextLineStart = cursor;
      if (!isBlankMarkdownLine(value, lineStart, cursor - 1)) {
        lastContentStart = lineStart;
        lastContentEnd = cursor - 1;
      }
      const advanced = advanceHtmlBlockState(value, lineStart, cursor - 1, openHtmlBlock);
      if (advanced === HTML_BLOCK_CLOSED) {
        openHtmlBlock = null;
        htmlBlockEndsLine = true;
      } else {
        if (advanced && advanced !== openHtmlBlock) {
          const openingDepth = containerDepth(value, lineStart, advanced.blockStart);
          htmlQuoteDepth = containerQuoteDepth(value, lineStart, advanced.blockStart);
          htmlListDepth = Math.max(
            openingDepth - htmlQuoteDepth,
            activeListIndent > 0 ? 1 : 0,
          );
          htmlContainerIndent = Math.max(
            visualColumn(value, lineStart, advanced.blockStart),
            activeListIndent,
          );
          // CommonMark forbids this opener from interrupting a paragraph; the scanner
          // opens it anyway, so the two readings of the lines below it are both live.
          if (advanced.kind.interrupts === false && followsParagraphContent(value, lineStart)) {
            ambiguous = true;
          }
        }
        openHtmlBlock = advanced;
      }
      // A raw block ends with the container it opened in, so the first line outside that
      // blockquote or list item is already free to start an indented code block.
      if (
        openHtmlBlock &&
        !continuesOpeningContainer(
          value,
          nextLineStart,
          htmlQuoteDepth,
          htmlListDepth,
          htmlContainerIndent,
        )
      ) {
        openHtmlBlock = null;
        htmlQuoteDepth = 0;
        htmlListDepth = 0;
        htmlContainerIndent = 0;
        htmlBlockEndsLine = true;
      }
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
        htmlBlockEndsLine,
        paragraphFloor,
      );
      if (
        indentedLineIsAmbiguous(
          value,
          nextLineStart,
          lineStart,
          cursor - 1,
          lastContentStart,
          lastContentEnd,
          activeListIndent,
        )
      ) {
        ambiguous = true;
      }
      // Lines inside an open raw block are markup, never the start of an indented code block.
      if (openHtmlBlock) indentedCodeLine = false;
      // Once a line belongs to a raw block, earlier lines can no longer hold an open
      // paragraph, so paragraph lookback must not walk past this boundary.
      if (openHtmlBlock || htmlBlockEndsLine) paragraphFloor = nextLineStart;
      htmlBlockEndsLine = false;
      lineStart = nextLineStart;
    }
  }
  return { text: result, ambiguous };
}

function markdownBodyStart(detail) {
  for (const pattern of DETAIL_BODY_PREFIX_RES) {
    const match = pattern.exec(detail);
    if (match) return match[0].length;
  }
  return 0;
}

// The fallback for an undecidable detail: every comment span goes, and so does an
// unterminated `<!--` tail, whose hidden text runs to the end of the value.
function dropEveryHtmlComment(value) {
  const stripped = value.replace(/<!--[\s\S]*?-->/gu, "");
  const unterminated = stripped.indexOf("<!--");
  return unterminated === -1 ? stripped : stripped.slice(0, unterminated);
}

function stripDetailHtmlComments(detail) {
  const bodyStart = markdownBodyStart(detail);
  const prefix = detail.slice(0, bodyStart);
  const body = detail.slice(bodyStart);
  const strippedPrefix = stripMarkdownHtmlComments(prefix);
  const strippedBody = stripMarkdownHtmlComments(body);
  // Markdown-aware fidelity holds only while the parse is certain. Otherwise the detail
  // loses every comment, hidden or not, and is reported for reconciliation: an omitted
  // detail sends the root agent to `get_pr`, where it reads the feedback in full.
  if (strippedPrefix.ambiguous || strippedBody.ambiguous) {
    return { value: dropEveryHtmlComment(prefix) + dropEveryHtmlComment(body), reconcile: true };
  }
  return { value: strippedPrefix.text + strippedBody.text, reconcile: false };
}

function removeDetailUrl(value) {
  for (const pattern of DETAIL_URL_RES) {
    if (pattern.test(value)) return value.replace(pattern, "$1");
  }
  return value;
}

function removeUnsafeControlCharacters(value) {
  return value.replace(
    CONTROL_CHARACTERS_RE,
    (character) => character === "\n" || character === "\t" ? character : "",
  );
}

function compactDetail(detail) {
  const withoutAnsi = detail.replace(ANSI_ESCAPE_SEQUENCE_RE, "");
  const preserveBody = markdownBodyStart(withoutAnsi) > 0;
  const stripped = stripDetailHtmlComments(withoutAnsi);
  const withoutUrl = removeDetailUrl(stripped.value);
  if (preserveBody) {
    return {
      value: removeUnsafeControlCharacters(withoutUrl.replace(/\r\n?/gu, "\n")).trim(),
      truncated: false,
      reconcile: stripped.reconcile,
      preserveBody: true,
    };
  }

  const value = withoutUrl
    .replace(/\s+/gu, " ")
    .replace(CONTROL_CHARACTERS_RE, "")
    .trim();
  return {
    value: truncate(value, MAX_DETAIL_LENGTH),
    truncated: value.length > MAX_DETAIL_LENGTH,
    reconcile: stripped.reconcile,
    preserveBody: false,
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
  const seenDetails = new Set();
  const details = compactedDetails.filter((detail) => {
    if (!detail.value || seenDetails.has(detail.value)) return false;
    seenDetails.add(detail.value);
    return true;
  });
  if (details.length === 0) return null;

  const actionable = [];
  // A reconciled detail lost comment text it could not classify, so it counts as omitted:
  // the overflow marker is what tells the root agent to call `get_pr` for the full body.
  let omitted = compactedDetails.filter((detail) => detail.truncated || detail.reconcile).length;
  for (const detail of details) {
    const match = OVERFLOW_DETAIL_RE.exec(detail.value);
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
    const parts = [...included.map((item) => item.value), detail.value];
    if (omittedAfterDetail > 0) parts.push(`+${omittedAfterDetail} more changes`);
    if (!detail.preserveBody && parts.join("\n").length > MAX_UPDATE_OUTPUT_LENGTH) break;
    included.push(detail);
  }
  omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + actionable.length - included.length);
  const output = included.map((detail) => detail.value);
  if (omitted > 0) output.push(`+${omitted} more changes`);
  if (output.length === 0) return null;
  return output.join("\n");
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
