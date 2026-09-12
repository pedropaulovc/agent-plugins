#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 10_000;
const VALID_TERMINAL_STATES = new Set(["watching", "merged", "closed"]);
const READY_LINE = "watch-pr: ready";

const CAPABILITY_FILE_MODE = 0o600;
const CAPABILITY_FILE_ATTEMPTS = 4;
const WINDOWS_COMMAND_TIMEOUT_MS = 10_000;
const USAGE = "usage: node watch-pr-monitor.mjs --url-file <path> | " +
  "node watch-pr-monitor.mjs mint [directory]";

class PermanentMonitorError extends Error { }

function permanent(message) {
  return new PermanentMonitorError(message);
}

function pathEquals(left, right) {
  const leftPath = resolve(left);
  const rightPath = resolve(right);
  return process.platform === "win32"
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}

function isPathInside(filePath, directory) {
  const normalizedFilePath = resolve(filePath);
  const normalizedDirectory = resolve(directory);
  const relativePath = process.platform === "win32"
    ? relative(normalizedDirectory.toLowerCase(), normalizedFilePath.toLowerCase())
    : relative(normalizedDirectory, normalizedFilePath);
  return relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath);
}

function isPathInsideOrEqual(filePath, directory) {
  return pathEquals(filePath, directory) || isPathInside(filePath, directory);
}

async function repositoryRoot(startDirectory = process.cwd()) {
  let directory = resolve(startDirectory);
  try {
    directory = await realpath(directory);
  } catch {
    // The lexical path is still useful when the start directory is inaccessible.
  }
  while (true) {
    try {
      const gitPath = await lstat(join(directory, ".git"));
      if (gitPath.isDirectory() || gitPath.isFile()) return directory;
    } catch {
      // Continue upward when the marker is absent or inaccessible.
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

async function capabilityDirectory(directory) {
  const targetDirectory = directory ?? tmpdir();
  if (!isAbsolute(targetDirectory)) {
    throw permanent("monitor URL file directory must be an absolute path");
  }
  if (/[\r\n]/.test(targetDirectory)) {
    throw permanent("monitor URL file directory must not contain line breaks");
  }
  if (process.platform === "win32" && !pathEquals(targetDirectory, tmpdir())) {
    throw permanent("custom monitor URL file directories are not supported on Windows");
  }

  let canonicalDirectory;
  try {
    canonicalDirectory = await realpath(targetDirectory);
  } catch {
    throw permanent("monitor URL file directory must exist");
  }
  const root = await repositoryRoot(canonicalDirectory);
  if (root && isPathInsideOrEqual(canonicalDirectory, root)) {
    throw permanent("monitor URL file directory must be outside the repository");
  }
  if (process.platform === "win32") {
    let canonicalHome;
    try {
      canonicalHome = await realpath(homedir());
    } catch {
      throw permanent("could not resolve the Windows user profile");
    }
    if (!isPathInside(canonicalDirectory, canonicalHome)) {
      throw permanent("the Windows monitor URL file directory must be under the user profile");
    }
  }
  return canonicalDirectory;
}

function runWindowsCommand(command, args, environment = process.env, input) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        env: environment,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let pendingError;
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const terminate = (error) => {
      if (settled || pendingError) return;
      pendingError = error;
      try {
        child.kill();
      } catch {
        // The process may have exited at the termination boundary.
      }
    };
    timer = setTimeout(() => {
      terminate(permanent(`Windows command timed out: ${command}`));
    }, WINDOWS_COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    child.stderr.resume();
    child.once("error", error => terminate(error));
    if (input !== undefined) {
      child.stdin.once("error", error => terminate(error));
      child.stdin.end(input);
    }
    child.once("close", (code, signal) => {
      if (pendingError) {
        finish(pendingError);
        return;
      }
      if (code === 0) {
        finish(undefined, { stdout });
        return;
      }
      const error = new Error(`${command} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`);
      error.exitCode = code;
      error.signal = signal;
      finish(error);
    });
  });
}

export async function readMonitorUrlFile(
  urlFile,
  { noFollowFlag = constants.O_NOFOLLOW } = {},
) {
  let capabilityPath = urlFile;
  let pathStat;
  try {
    pathStat = await lstat(capabilityPath);
  } catch {
    throw permanent("could not open the monitor URL file");
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw permanent("monitor URL file must be a regular file, not a symbolic link");
  }
  if (process.platform === "win32") {
    capabilityPath = await canonicalWindowsCapabilityPath(urlFile);
    try {
      pathStat = await lstat(capabilityPath);
    } catch {
      throw permanent("monitor URL file changed while it was being opened");
    }
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw permanent("monitor URL file must be a regular file, not a symbolic link");
    }
  }
  if (process.platform !== "win32") {
    let canonicalPath;
    try {
      canonicalPath = await realpath(capabilityPath);
    } catch {
      throw permanent("monitor URL file changed while it was being opened");
    }
    await assertOutsideRepository(canonicalPath);
  }
  if (process.platform !== "win32" && (pathStat.mode & 0o077) !== 0) {
    throw permanent("monitor URL file permissions must not grant group or other access");
  }

  let handle;
  try {
    handle = await open(capabilityPath, constants.O_RDONLY | (noFollowFlag ?? 0));
  } catch (error) {
    const noFollowUnsupported = noFollowFlag !== undefined && [
      "EINVAL",
      "ENOTSUP",
      "EOPNOTSUPP",
    ].includes(error?.code);
    if (!noFollowUnsupported) {
      throw permanent("could not safely open the monitor URL file");
    }
    try {
      handle = await open(capabilityPath, constants.O_RDONLY);
    } catch {
      throw permanent("could not safely open the monitor URL file");
    }
  }

  try {
    const openedStat = await handle.stat();
    let currentPathStat;
    try {
      currentPathStat = await lstat(capabilityPath);
    } catch {
      throw permanent("monitor URL file changed while it was being opened");
    }
    if (
      currentPathStat.isSymbolicLink() ||
      !sameFile(pathStat, openedStat) ||
      !sameFile(openedStat, currentPathStat)
    ) {
      throw permanent("monitor URL file changed while it was being opened");
    }

    const monitorUrl = (await handle.readFile("utf8")).trim();
    if (!monitorUrl) {
      throw permanent("monitor URL file was empty");
    }

    try {
      currentPathStat = await lstat(capabilityPath);
    } catch {
      throw permanent("monitor URL file changed before it could be removed");
    }
    if (currentPathStat.isSymbolicLink() || !sameFile(openedStat, currentPathStat)) {
      throw permanent("monitor URL file changed before it could be removed");
    }
    try {
      await unlink(capabilityPath);
    } catch {
      throw permanent("could not remove the monitor URL file after reading it");
    }
    return monitorUrl;
  } finally {
    await handle.close();
  }
}

const WINDOWS_FILE_ALREADY_EXISTS_EXIT_CODE = 20;
const WINDOWS_CREATE_FILE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$source = @(",
  "  'using System;'",
  "  'using System.Runtime.InteropServices;'",
  "  'public static class WatchPrNative {'",
  "  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]'",
  "  '  public struct SecurityAttributes {'",
  "  '    public int Length;'",
  "  '    public IntPtr SecurityDescriptor;'",
  "  '    [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;'",
  "  '  }'",
  "  '  [DllImport(\"kernel32.dll\", SetLastError = true, CharSet = CharSet.Unicode)]'",
  "  '  public static extern IntPtr CreateFile(string name, uint access, uint share, ref SecurityAttributes attributes, uint creation, uint flags, IntPtr template);'",
  "  '  [DllImport(\"kernel32.dll\", SetLastError = true)]'",
  "  '  [return: MarshalAs(UnmanagedType.Bool)]'",
  "  '  public static extern bool WriteFile(IntPtr handle, byte[] data, int count, out int written, IntPtr overlapped);'",
  "  '  [DllImport(\"kernel32.dll\", SetLastError = true)]'",
  "  '  [return: MarshalAs(UnmanagedType.Bool)]'",
  "  '  public static extern bool CloseHandle(IntPtr handle);'",
  "  '  [DllImport(\"advapi32.dll\", CharSet = CharSet.Unicode, SetLastError = true)]'",
  "  '  public static extern uint GetNamedSecurityInfo(string name, uint objectType, uint securityInfo, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);'",
  "  '  [DllImport(\"advapi32.dll\", SetLastError = true)]'",
  "  '  public static extern uint GetSecurityDescriptorLength(IntPtr descriptor);'",
  "  '  [DllImport(\"kernel32.dll\", SetLastError = true)]'",
  "  '  public static extern IntPtr LocalFree(IntPtr memory);'",
  "  '}'",
  ") -join [Environment]::NewLine",
  "Add-Type -TypeDefinition $source",
  "$path = $env:WATCH_PR_CAPABILITY_FILE",
  "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$url = [Console]::In.ReadToEnd()",
  "$sddl = 'D:P(A;;FA;;;' + $identity.Value + ')'",
  "$descriptor = New-Object System.Security.AccessControl.RawSecurityDescriptor($sddl)",
  "$descriptorBytes = New-Object byte[] $descriptor.BinaryLength",
  "$descriptor.GetBinaryForm($descriptorBytes, 0)",
  "$descriptorMemory = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($descriptorBytes.Length)",
  "$handle = [IntPtr]::Zero",
  "$collision = $false",
  "try {",
  "  [System.Runtime.InteropServices.Marshal]::Copy($descriptorBytes, 0, $descriptorMemory, $descriptorBytes.Length)",
  "  $attributes = New-Object WatchPrNative+SecurityAttributes",
  "  $attributes.Length = [System.Runtime.InteropServices.Marshal]::SizeOf($attributes)",
  "  $attributes.SecurityDescriptor = $descriptorMemory",
  "  $handle = [WatchPrNative]::CreateFile($path, 0x40000000, 0, [ref]$attributes, 1, 0x80, [IntPtr]::Zero)",
  "  if ($handle.ToInt64() -eq -1) {",
  "    $nativeError = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()",
  "    if ($nativeError -eq 80 -or $nativeError -eq 183) { $collision = $true } else { throw ('CreateFile failed with Win32 error ' + $nativeError) }",
  "  }",
  "  if (-not $collision) {",
  "    $bytes = [System.Text.Encoding]::UTF8.GetBytes($url)",
  "    $written = 0",
  "    if (-not [WatchPrNative]::WriteFile($handle, $bytes, $bytes.Length, [ref]$written, [IntPtr]::Zero) -or $written -ne $bytes.Length) { throw 'WriteFile failed' }",
  "  }",
  "} finally {",
  "  if ($handle -ne [IntPtr]::Zero -and $handle.ToInt64() -ne -1) { [void][WatchPrNative]::CloseHandle($handle) }",
  "  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($descriptorMemory)",
  "}",
  "if ($collision) { exit 20 }",
  "$owner = [IntPtr]::Zero",
  "$group = [IntPtr]::Zero",
  "$dacl = [IntPtr]::Zero",
  "$sacl = [IntPtr]::Zero",
  "$nativeDescriptor = [IntPtr]::Zero",
  "$status = [WatchPrNative]::GetNamedSecurityInfo($path, 1, 4, [ref]$owner, [ref]$group, [ref]$dacl, [ref]$sacl, [ref]$nativeDescriptor)",
  "if ($status -ne 0) { throw ('GetNamedSecurityInfo failed with Win32 error ' + $status) }",
  "try {",
  "  $length = [WatchPrNative]::GetSecurityDescriptorLength($nativeDescriptor)",
  "  if ($length -eq 0) { throw 'capability file security descriptor is empty' }",
  "  $actualBytes = New-Object byte[] $length",
  "  [System.Runtime.InteropServices.Marshal]::Copy($nativeDescriptor, $actualBytes, 0, $length)",
  "  $actual = New-Object System.Security.AccessControl.RawSecurityDescriptor($actualBytes, 0)",
  "  if (($actual.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0) { throw 'capability file ACL is inherited' }",
  "  $rules = $actual.DiscretionaryAcl",
  "  if ($rules.Count -ne 1) { throw 'capability file ACL is not owner-only' }",
  "  $rule = $rules[0]",
  "  if ($rule.AceType -ne [System.Security.AccessControl.AceType]::AccessAllowed -or $rule.AceFlags -ne [System.Security.AccessControl.AceFlags]::None -or $rule.AccessMask -ne 2032127 -or $rule.SecurityIdentifier.Value -ne $identity.Value) { throw 'capability file ACL is not owner-only' }",
  "} finally {",
  "  if ($nativeDescriptor -ne [IntPtr]::Zero) { [void][WatchPrNative]::LocalFree($nativeDescriptor) }",
  "}",
].join("; ");

function windowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) {
    throw permanent("could not locate Windows PowerShell");
  }
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
async function secureWindowsCapabilityFile(urlFile, monitorUrl) {
  if (process.platform !== "win32") return;
  let powershellPath;
  try {
    powershellPath = windowsPowerShellPath();
  } catch (error) {
    if (error instanceof PermanentMonitorError) throw error;
    throw permanent("could not locate Windows PowerShell");
  }
  try {
    await runWindowsCommand(powershellPath, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_CREATE_FILE_SCRIPT,
    ], {
      ...process.env,
      WATCH_PR_CAPABILITY_FILE: urlFile,
    }, monitorUrl);
  } catch (error) {
    if (error?.exitCode === WINDOWS_FILE_ALREADY_EXISTS_EXIT_CODE) throw error;
    throw permanent("could not create the private monitor URL file");
  }
}

async function assertOutsideRepository(canonicalPath) {
  const root = await repositoryRoot(dirname(canonicalPath));
  if (root && isPathInsideOrEqual(canonicalPath, root)) {
    throw permanent("monitor URL file must be outside the repository");
  }
}

async function canonicalWindowsCapabilityPath(urlFile) {
  if (process.platform !== "win32") return urlFile;
  let canonicalFile;
  let canonicalTemp;
  let canonicalHome;
  try {
    canonicalFile = await realpath(urlFile);
    canonicalTemp = await realpath(tmpdir());
    canonicalHome = await realpath(homedir());
  } catch {
    throw permanent("monitor URL file must be in the OS temporary directory on Windows");
  }
  if (!isPathInside(canonicalFile, canonicalTemp) || !isPathInside(canonicalFile, canonicalHome)) {
    throw permanent("monitor URL file must be in the user's OS temporary directory on Windows");
  }
  await assertOutsideRepository(canonicalFile);
  return canonicalFile;
}

function sameFile(left, right) {
  return left.dev !== 0 && left.ino !== 0 &&
    left.dev === right.dev && left.ino === right.ino;
}


function readMonitorUrlFromStdin(signal) {
  if (signal?.aborted) return Promise.reject(permanent("monitor URL minting was cancelled"));

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      input.removeListener("line", onLine);
      input.removeListener("close", onClose);
      process.stdin.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      input.close();
      process.stdin.pause();
      process.stdin.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const onLine = (line) => finish(undefined, line);
    const onClose = () => finish(undefined, "");
    const onError = (error) => finish(error);
    const onAbort = () => finish(permanent("monitor URL minting was cancelled"));

    input.once("line", onLine);
    input.once("close", onClose);
    process.stdin.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function mintMonitorUrlFile(directory, { signal } = {}) {
  const targetDirectory = await capabilityDirectory(directory);
  let input;
  try {
    input = await readMonitorUrlFromStdin(signal);
  } catch (error) {
    if (error instanceof PermanentMonitorError) throw error;
    throw permanent("could not read monitor URL from stdin");
  }
  const monitorUrl = input.trim();
  if (!monitorUrl) throw permanent("monitor URL from stdin was empty");
  if (/\s/.test(monitorUrl)) {
    throw permanent("monitor URL from stdin must contain one URL");
  }

  for (let attempt = 0; attempt < CAPABILITY_FILE_ATTEMPTS; attempt += 1) {
    const urlFile = join(targetDirectory, `watch-pr-monitor-${randomUUID()}.url`);
    if (process.platform === "win32") {
      try {
        await secureWindowsCapabilityFile(urlFile, monitorUrl);
      } catch (error) {
        if (error?.exitCode === WINDOWS_FILE_ALREADY_EXISTS_EXIT_CODE) continue;
        await removeUnpublishedCapabilityFile(urlFile);
        if (error instanceof PermanentMonitorError) throw error;
        throw permanent("could not create the monitor URL file");
      }
      if (signal?.aborted) {
        await removeUnpublishedCapabilityFile(urlFile);
        throw permanent("monitor URL minting was cancelled");
      }
      return urlFile;
    }

    let handle;
    try {
      handle = await open(
        urlFile,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        CAPABILITY_FILE_MODE,
      );
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw permanent("could not create the monitor URL file");
    }

    try {
      await handle.chmod(CAPABILITY_FILE_MODE);
      if (signal?.aborted) throw permanent("monitor URL minting was cancelled");
      let currentPathStat;
      let openedStat;
      try {
        openedStat = await handle.stat();
        currentPathStat = await lstat(urlFile);
      } catch {
        throw permanent("monitor URL file changed while it was being secured");
      }
      if (currentPathStat.isSymbolicLink() || !sameFile(openedStat, currentPathStat)) {
        throw permanent("monitor URL file changed while it was being secured");
      }
      await handle.writeFile(monitorUrl, "utf8");
      await handle.close();
      if (signal?.aborted) throw permanent("monitor URL minting was cancelled");
      return urlFile;
    } catch (error) {
      await handle.close().catch(() => { });
      await removeUnpublishedCapabilityFile(urlFile);
      if (error instanceof PermanentMonitorError) throw error;
      throw permanent("could not write the monitor URL file");
    }
  }

  throw permanent("could not create a unique monitor URL file");
}

async function removeUnpublishedCapabilityFile(urlFile) {
  try {
    await unlink(urlFile);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw permanent(`could not remove unpublished monitor URL file: ${urlFile}`);
  }
}

function writeStdout(text) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onError = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    process.stdout.once("error", onError);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    try {
      process.stdout.write(text, finish);
    } catch (error) {
      process.stdout.removeListener("error", onError);
      finish(error);
    }
  });
}

export async function mintFromStdin(directory) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  let urlFile;
  let published = false;
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    urlFile = await mintMonitorUrlFile(directory, { signal: controller.signal });
    if (controller.signal.aborted) throw permanent("monitor URL minting was cancelled");
    await writeStdout(`${urlFile}\n`);
    if (controller.signal.aborted) throw permanent("monitor URL minting was cancelled");
    published = true;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (urlFile && !published) await removeUnpublishedCapabilityFile(urlFile);
  }
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

function formatMonitorEvent(event) {
  if (!Number.isInteger(event.pullRequestNumber) || event.pullRequestNumber <= 0) {
    throw permanent("received an invalid pull request number");
  }

  if (event.terminalState === "merged" || event.terminalState === "closed") {
    return `PR ${event.pullRequestNumber} finished: ${event.terminalState.toUpperCase()}`;
  }

  if (!Array.isArray(event.changes) || event.changes.some((change) => typeof change !== "string")) {
    throw permanent("received invalid monitor event changes");
  }
  const changes = [...new Set(event.changes.map((change) => change.replace(/\s+/g, " ").trim()))]
    .filter(Boolean);
  let summary = changes.join(", ");
  if (!summary) {
    if (typeof event.githubEvent !== "string") {
      throw permanent("received a monitor event without a GitHub event");
    }
    summary = event.githubEvent.replace(/\s+/g, " ").trim();
    if (!summary) throw permanent("received an empty GitHub event");
  }
  return `PR ${event.pullRequestNumber} updated: ${summary}`;
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
  let parsedUrl;
  try {
    parsedUrl = new URL(monitorUrl);
  } catch {
    throw permanent("monitor URL file did not contain a valid URL");
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
          process.stdout.write(`${READY_LINE}\n`);
          readyEmitted = true;
        }
        for await (const frame of parseEventStream(response.body)) {
          const parsed = parseMonitorEvent(frame);
          cursor = parsed.id;
          receivedEvent = true;
          reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
          if (parsed.id === lastPrintedId) continue;

          process.stdout.write(`${formatMonitorEvent(parsed.event)}\n`);
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
  const args = process.argv.slice(2);
  if (args[0] === "mint") {
    if (args.length > 2) throw permanent(USAGE);
    await mintFromStdin(args[1]);
    return;
  }

  if (args.length !== 2 || args[0] !== "--url-file") {
    throw permanent(USAGE);
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const monitorUrl = await readMonitorUrlFile(args[1]);
    await watchPrMonitor(monitorUrl, { signal: controller.signal });
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
