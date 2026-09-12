#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 10_000;
const VALID_TERMINAL_STATES = new Set(["watching", "merged", "closed"]);

class PermanentMonitorError extends Error { }

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

function validateResponse(response) {
  if ([401, 403, 404].includes(response.status)) {
    throw permanent(
      `monitor URL was rejected with HTTP ${response.status}; return to the root session, stop this watch, and call unwatch_pr`,
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
  const parsedUrl = new URL(monitorUrl);
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
  let cursor;
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
      if (!validateResponse(response)) {
        await response.body?.cancel();
      } else {
        if (!readyEmitted) {
          process.stdout.write('{"type":"ready","terminalState":"watching"}\n');
          readyEmitted = true;
        }
        for await (const frame of parseEventStream(response.body)) {
          const parsed = parseMonitorEvent(frame);
          cursor = parsed.id;
          receivedEvent = true;
          reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
          if (parsed.id === lastPrintedId) continue;

          process.stdout.write(`${JSON.stringify(parsed.event)}\n`);
          lastPrintedId = parsed.id;
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
  if (process.argv.length !== 3) {
    throw permanent("usage: node watch-pr-monitor.mjs <monitor-url>");
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await watchPrMonitor(process.argv[2], { signal: controller.signal });
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
