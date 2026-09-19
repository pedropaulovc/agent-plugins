#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 10_000;
const VALID_TERMINAL_STATES = new Set(["watching", "merged", "closed"]);
const READY_LINE = "watch-pr: ready";
const USAGE = "usage: node watch-pr-monitor.mjs <monitor-url>";

class PermanentMonitorError extends Error { }
const MAX_DETAIL_LENGTH = 1_000;
const MAX_UPDATE_LINE_LENGTH = 4_096;
const CONTROL_CHARACTERS_RE = /[\u0000-\u001f\u007f-\u009f]/gu;
const ANSI_ESCAPE_SEQUENCE_RE = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/gu;
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

function compactDetail(detail) {
  const value = detail
    .replace(ANSI_ESCAPE_SEQUENCE_RE, "")
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

  const prefix = `PR ${event.pullRequestNumber} updated: `;
  const included = [];
  for (const detail of actionable) {
    const omittedAfterDetail = omitted + actionable.length - included.length - 1;
    const parts = [...included, detail];
    if (omittedAfterDetail > 0) parts.push(`+${omittedAfterDetail} more changes`);
    if (`${prefix}${parts.join(" | ")}`.length > MAX_UPDATE_LINE_LENGTH) break;
    included.push(detail);
  }
  omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + actionable.length - included.length);
  if (omitted > 0) included.push(`+${omitted} more changes`);
  if (included.length === 0) return null;
  return `${prefix}${included.join(" | ")}`;
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
