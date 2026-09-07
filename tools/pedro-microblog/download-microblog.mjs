#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_OUTPUT = "/tmp/pedro-microblog-archive";
const DEFAULT_X_ENV_FILE = "/tmp/twitterapi.env";
const DEFAULT_THREADS_HANDLE = "pedropaulovc";
const DEFAULT_THREADS_SESSION = "pedro-microblog-threads";
const X_API = "https://api.twitterapi.io";
const MASTODON_API = "https://mastodon.social/api/v1";
const BLUESKY_PUBLIC_API = "https://public.api.bsky.app/xrpc";
const COLLECTOR = fileURLToPath(new URL("./threads-collector.js", import.meta.url));
const USER_AGENT = "pedro-microblog-maintainer-updater/1.0";
const USAGE = `Usage: node tools/pedro-microblog/download-microblog.mjs [options]

Options:
  --output PATH                 Archive directory (default: /tmp/pedro-microblog-archive)
  --platform LIST               all, twitter, threads, mastodon, bluesky (default: all)
  --x-env-file PATH             Env file containing TWITTERAPI_API_TOKEN
                                (default: /tmp/twitterapi.env)
  --twitter-min-interval-ms N   Delay between TwitterAPI.io requests (default: 5000)
  --threads-handle HANDLE       Threads handle (default: pedropaulovc)
  --threads-session NAME        Named headed playwright-cli session
                                (default: pedro-microblog-threads)
  --max-pages N                 Safety cap per API (default: 10000)
  --since ISO                   Keep posts on/after this instant after fetching
  --until ISO                   Keep posts before this instant after fetching
  --allow-partial               Exit zero when one or more platforms fail
  --help                        Show this help
`;

function parseArgs(argv) {
  const options = {
    output: DEFAULT_OUTPUT,
    platforms: ["twitter", "threads", "mastodon", "bluesky"],
    xEnvFile: DEFAULT_X_ENV_FILE,
    twitterMinIntervalMs: 5000,
    threadsHandle: DEFAULT_THREADS_HANDLE,
    threadsSession: DEFAULT_THREADS_SESSION,
    maxPages: 10000,
    since: null,
    until: null,
    allowPartial: false,
  };
  const values = (index, key) => {
    const argument = argv[index];
    const equal = argument.indexOf("=");
    if (equal >= 0) return [argument.slice(equal + 1), index];
    if (argv[index + 1] === undefined) throw new Error(`Missing value for ${key}`);
    return [argv[index + 1], index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (argument === "--allow-partial") {
      options.allowPartial = true;
      continue;
    }
    const specs = {
      "--output": ["output", value => value],
      "--platform": ["platforms", value => value.split(",").map(item => item.trim().toLowerCase())],
      "--x-env-file": ["xEnvFile", value => value],
      "--twitter-min-interval-ms": ["twitterMinIntervalMs", value => positiveInteger(value, "--twitter-min-interval-ms")],
      "--threads-handle": ["threadsHandle", value => value.replace(/^@/, "")],
      "--threads-session": ["threadsSession", value => value],
      "--max-pages": ["maxPages", value => positiveInteger(value, "--max-pages")],
      "--since": ["since", value => parseDate(value, "--since")],
      "--until": ["until", value => parseDate(value, "--until")],
    };
    const spec = specs[argument.split("=", 1)[0]];
    if (!spec) throw new Error(`Unknown argument: ${argument}\n${USAGE}`);
    const [value, nextIndex] = values(index, spec[0]);
    options[spec[0]] = spec[1](value);
    index = nextIndex;
  }

  const aliases = new Map([["x", "twitter"], ["bsky", "bluesky"]]);
  options.platforms = [...new Set(options.platforms.map(platform => aliases.get(platform) ?? platform))];
  const supported = new Set(["twitter", "threads", "mastodon", "bluesky"]);
  const invalid = options.platforms.filter(platform => !supported.has(platform));
  if (invalid.length) throw new Error(`Unsupported platform: ${invalid.join(", ")}`);
  if (options.since && options.until && options.since >= options.until) throw new Error("--since must be before --until");
  return options;
}

function positiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function parseDate(value, option) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`${option} must be an ISO date`);
  return parsed;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function requestJson(url, options = {}) {
  const retries = options.retries ?? 3;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        method: options.method ?? "GET",
        headers: { accept: "application/json", "user-agent": USER_AGENT, ...(options.headers ?? {}) },
        signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
      });
    } catch (error) {
      if (attempt === retries) throw error;
      await sleep(1000 * (attempt + 1));
      continue;
    }
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`${url} returned non-JSON (${response.status})`);
    }
    if (response.ok) return { data, headers: response.headers, status: response.status };
    const transient = response.status === 429 || response.status >= 500;
    if (!transient || attempt === retries) {
      const detail = data?.message || data?.error || response.statusText;
      throw new Error(`${url} returned ${response.status}: ${detail}`);
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (attempt + 1));
  }
  throw new Error("unreachable request state");
}

async function readToken(file) {
  const text = await readFile(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(TWITTERAPI_API_TOKEN|TWITTER_API_TOKEN|TWITTER_API_KEY)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    return match[2].replace(/^['"]|['"]$/g, "");
  }
  throw new Error(`No TwitterAPI.io token found in ${file}`);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function tweetArray(payload) {
  if (Array.isArray(payload?.tweets)) return payload.tweets;
  if (Array.isArray(payload?.data?.tweets)) return payload.data.tweets;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function nextCursor(payload) {
  return payload?.next_cursor ?? payload?.data?.next_cursor ?? payload?.nextCursor ?? payload?.data?.nextCursor ?? null;
}

function first(value, keys) {
  for (const key of keys) {
    const parts = key.split("?.");
    let current = value;
    for (const part of parts) current = current?.[part];
    if (current !== undefined && current !== null) return current;
  }
  return null;
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function htmlToText(value) {
  return decodeHtml(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function mediaList(value) {
  return asArray(value).map(item => ({
    type: first(item, ["type", "media_type"]),
    url: first(item, ["url", "media_url_https", "media_url", "src"]),
    previewUrl: first(item, ["preview_image_url", "thumbnail_url"]),
    alt: first(item, ["alt_text", "alt"]),
  })).filter(item => item.url || item.previewUrl);
}

function normalizePost(platform, raw, capturedAt, extra = {}) {
  const id = String(first(raw, ["id", "id_str", "uri", "postId", "shortcode"]) ?? "");
  const textValue = first(raw, ["text", "full_text", "content", "record"]);
  const text = htmlToText(typeof textValue === "object" ? first(textValue, ["text"]) : textValue);
  const createdAt = first(raw, ["createdAt", "created_at", "indexedAt", "timestamp"]);
  return {
    platform,
    id,
    url: first(raw, ["url", "permalink", "webUrl"]) ?? extra.url ?? null,
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    text,
    media: mediaList(first(raw, ["media", "attachments", "embed?.media"]) ?? []),
    isReply: Boolean(first(raw, ["isReply", "in_reply_to_status_id", "reply"]) || extra.isReply),
    isRepost: Boolean(first(raw, ["isRepost", "retweeted", "reblog", "reason"]) || extra.isRepost),
    capturedAt,
    provenance: extra.provenance ?? null,
    source: raw,
  };
}

function sortPosts(posts) {
  return [...posts].sort((left, right) => {
    const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
    const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
    return rightTime - leftTime || left.id.localeCompare(right.id);
  });
}

function addPost(map, post) {
  if (!post.id) return;
  const existing = map.get(post.id);
  if (!existing || post.text.length > existing.text.length || post.media.length > existing.media.length) map.set(post.id, post);
}

function twitterSearchQuery(handle, start, end) {
  return `from:${handle} since_time:${Math.floor(start.valueOf() / 1000)} until_time:${Math.floor(end.valueOf() / 1000)}`;
}

async function crawlTwitterSearch({ handle, token, profile, capturedAt, options, posts }) {
  const created = new Date(profile.createdAt ?? "2006-03-21T00:00:00Z");
  const end = new Date();
  const warnings = [];
  let pages = 0;
  let previousRequest = 0;
  const request = async url => {
    const elapsed = Date.now() - previousRequest;
    if (elapsed < options.twitterMinIntervalMs) await sleep(options.twitterMinIntervalMs - elapsed);
    previousRequest = Date.now();
    return requestJson(url, { headers: { "X-API-Key": token } });
  };

  for (let start = new Date(created); start < end && pages < options.maxPages; start = new Date(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate())) {
    const windowEnd = new Date(Math.min(new Date(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate()).valueOf(), end.valueOf()));
    let cursor = "";
    const seenCursors = new Set();
    while (pages < options.maxPages) {
      const params = new URLSearchParams({ query: twitterSearchQuery(handle, start, windowEnd), queryType: "Latest" });
      if (cursor) params.set("cursor", cursor);
      const payload = (await request(`${X_API}/twitter/tweet/advanced_search?${params}`)).data;
      pages += 1;
      for (const raw of tweetArray(payload)) {
        const author = first(raw, ["userName", "author?.userName", "author?.handle"]);
        addPost(posts, normalizePost("twitter", raw, capturedAt, {
          isReply: Boolean(raw.inReplyToTweetId || raw.in_reply_to_status_id),
          isRepost: Boolean(raw.retweeted_tweet || raw.retweetedTweet),
          provenance: { source: "advanced_search", query: params.get("query"), page: pages },
        }));
        if (author && String(author).toLowerCase() !== handle.toLowerCase()) posts.delete(String(first(raw, ["id", "id_str"])));
      }
      const next = nextCursor(payload);
      if (!next || seenCursors.has(next)) {
        if (next && seenCursors.has(next)) warnings.push(`TwitterAPI.io repeated a cursor in ${start.toISOString()}..${windowEnd.toISOString()}.`);
        break;
      }
      seenCursors.add(next);
      cursor = next;
    }
  }
  return { pages, warnings };
}

async function crawlTwitterTimeline({ userId, token, capturedAt, options, posts }) {
  let cursor = "";
  let pages = 0;
  let previousRequest = 0;
  const seenCursors = new Set();
  while (pages < options.maxPages) {
    const elapsed = Date.now() - previousRequest;
    if (elapsed < options.twitterMinIntervalMs) await sleep(options.twitterMinIntervalMs - elapsed);
    const params = new URLSearchParams({ userId, includeReplies: "true" });
    if (cursor) params.set("cursor", cursor);
    previousRequest = Date.now();
    const payload = (await requestJson(`${X_API}/twitter/user/last_tweets?${params}`, { headers: { "X-API-Key": token } })).data;
    pages += 1;
    for (const raw of tweetArray(payload)) addPost(posts, normalizePost("twitter", raw, capturedAt, { provenance: { source: "last_tweets", page: pages } }));
    const next = nextCursor(payload);
    if (!next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }
  return pages;
}

async function downloadTwitter(options, capturedAt) {
  const token = await readToken(options.xEnvFile);
  const infoUrl = `${X_API}/twitter/user/info?userName=${encodeURIComponent("pedrovc")}`;
  const infoPayload = (await requestJson(infoUrl, { headers: { "X-API-Key": token } })).data;
  const profile = infoPayload?.data ?? infoPayload;
  const userId = String(first(profile, ["id", "userId"]));
  if (!userId || userId === "null") throw new Error("Twitter profile response did not contain a user ID");
  const posts = new Map();
  const search = await crawlTwitterSearch({ handle: "pedrovc", token, profile, capturedAt, options, posts });
  const timelinePages = await crawlTwitterTimeline({ userId, token, capturedAt, options, posts });
  return {
    profile,
    posts: sortPosts(posts.values()),
    expectedCount: Number.isFinite(Number(profile.statusesCount)) ? Number(profile.statusesCount) : null,
    complete: true,
    coverage: "best_effort_public_index",
    stopReason: "source_cursors_exhausted",
    warnings: search.warnings,
    pages: search.pages + timelinePages,
  };
}

function nextLink(linkHeader) {
  for (const link of String(linkHeader ?? "").split(",")) {
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

async function downloadMastodon(options, capturedAt) {
  const account = (await requestJson(`${MASTODON_API}/accounts/lookup?acct=${encodeURIComponent("pedrovc")}`)).data;
  let url = `${MASTODON_API}/accounts/${account.id}/statuses?limit=40&exclude_replies=false&exclude_reblogs=false`;
  const posts = new Map();
  let pages = 0;
  while (url && pages < options.maxPages) {
    const response = await requestJson(url);
    pages += 1;
    for (const raw of asArray(response.data)) addPost(posts, normalizePost("mastodon", raw, capturedAt, {
      url: raw.url,
      isReply: Boolean(raw.in_reply_to_id),
      isRepost: Boolean(raw.reblog),
      provenance: { source: "account_statuses", page: pages },
    }));
    url = nextLink(response.headers.get("link"));
  }
  return {
    profile: account,
    posts: sortPosts(posts.values()),
    expectedCount: Number.isFinite(Number(account.statuses_count)) ? Number(account.statuses_count) : null,
    complete: !url,
    coverage: "best_effort_public_endpoint",
    stopReason: url ? "max_pages" : "link_pagination_exhausted",
    warnings: [],
    pages,
  };
}

async function downloadBluesky(options, capturedAt) {
  const handle = "pedro.vza.net";
  const profile = (await requestJson(`${BLUESKY_PUBLIC_API}/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`)).data;
  const actor = profile.did;
  const posts = new Map();
  let cursor = "";
  let pages = 0;
  let repeatedCursor = false;
  while (pages < options.maxPages) {
    const params = new URLSearchParams({ actor, filter: "posts_with_replies", includePins: "false", limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const payload = (await requestJson(`${BLUESKY_PUBLIC_API}/app.bsky.feed.getAuthorFeed?${params}`)).data;
    pages += 1;
    for (const item of asArray(payload.feed)) {
      const post = item.post;
      const authorDid = post?.author?.did;
      addPost(posts, normalizePost("bluesky", {
        id: post?.uri,
        uri: post?.uri,
        indexedAt: post?.record?.createdAt ?? post?.indexedAt,
        text: post?.record?.text,
        embed: post?.embed,
        author: post?.author,
      }, capturedAt, {
        url: post?.permalink ?? `https://bsky.app/profile/${handle}/post/${post?.uri?.split("/").pop() ?? ""}`,
        isReply: Boolean(post?.record?.reply),
        isRepost: Boolean(item.reason) || authorDid !== actor,
        provenance: { source: "app.bsky.feed.getAuthorFeed", page: pages, cursor: cursor || null },
      }));
    }
    const next = payload.cursor ?? null;
    if (!next || next === cursor || !payload.feed?.length) {
      repeatedCursor = Boolean(next && next === cursor);
      break;
    }
    cursor = next;
  }
  return {
    profile,
    posts: sortPosts(posts.values()),
    expectedCount: Number.isFinite(Number(profile.postsCount)) ? Number(profile.postsCount) : null,
    complete: !repeatedCursor && pages < options.maxPages,
    coverage: "best_effort_appview_index",
    stopReason: repeatedCursor ? "repeated_cursor" : pages >= options.maxPages ? "max_pages" : "cursor_exhausted",
    warnings: [],
    pages,
  };
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${command} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function parseCollectorOutput(text) {
  try {
    return JSON.parse(text.trim());
  } catch {
    const lines = text.trim().split(/\r?\n/).reverse();
    for (const line of lines) {
      try { return JSON.parse(line); } catch { }
    }
  }
  throw new Error("playwright-cli collector did not return JSON");
}

async function downloadThreads(options, capturedAt) {
  const url = `https://www.threads.com/@${encodeURIComponent(options.threadsHandle)}`;
  const session = `-s=${options.threadsSession}`;
  await runProcess("playwright-cli", [session, "open", "--headed", "--persistent", url]);
  try {
    await runProcess("playwright-cli", [session, "goto", url]);
    const result = parseCollectorOutput((await runProcess("playwright-cli", [session, "--raw", "run-code", `--filename=${COLLECTOR}`])).stdout);
    if (result.status !== "ok") {
      const error = new Error(`Threads collector status: ${result.status}`);
      error.keepSessionOpen = true;
      error.threadsResult = result;
      throw error;
    }
    await runProcess("playwright-cli", [session, "close"]);
    return {
      profile: result.profile,
      posts: sortPosts(asArray(result.posts).map(raw => normalizePost("threads", raw, capturedAt, {
        url: raw.url,
        provenance: { source: "headed_dom_collector", scrolls: result.scrolls },
      }))),
      expectedCount: null,
      complete: Boolean(result.complete),
      coverage: "best_effort_visible_profile",
      stopReason: result.stopReason ?? "unknown",
      warnings: result.complete ? [] : ["Threads stopped before an explicit terminal marker; this is not historical completeness."],
      pages: result.scrolls ?? 0,
    };
  } catch (error) {
    if (!error.keepSessionOpen) {
      try { await runProcess("playwright-cli", [session, "close"]); } catch { }
    }
    throw error;
  }
}

function filterPosts(posts, options) {
  return posts.filter(post => {
    if (options.since && post.createdAt && new Date(post.createdAt) < options.since) return false;
    if (options.until && post.createdAt && new Date(post.createdAt) >= options.until) return false;
    return true;
  });
}

async function writePlatform(output, platform, result, options) {
  const directory = path.join(output, platform);
  await mkdir(directory, { recursive: true });
  const posts = filterPosts(result.posts, options);
  const authored = posts.filter(post => !post.isRepost).length;
  const warnings = [...(result.warnings ?? [])];
  if (Number.isFinite(result.expectedCount) && authored !== result.expectedCount) {
    warnings.push(`Source profile count is ${result.expectedCount}; ${authored} authored records were returned. Treat the difference as a coverage warning, not a count to fill by inference.`);
  }
  await writeFile(path.join(directory, "profile.json"), `${JSON.stringify(result.profile, null, 2)}\n`);
  await writeFile(path.join(directory, "posts.ndjson"), posts.length ? `${posts.map(post => JSON.stringify(post)).join("\n")}\n` : "");
  return {
    platform,
    status: "ok",
    fetched: result.posts.length,
    written: posts.length,
    authored,
    expectedCount: result.expectedCount ?? null,
    complete: result.complete,
    coverage: result.coverage,
    stopReason: result.stopReason,
    warnings,
    pages: result.pages,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const capturedAt = new Date().toISOString();
  await mkdir(options.output, { recursive: true });
  const downloaders = { twitter: downloadTwitter, threads: downloadThreads, mastodon: downloadMastodon, bluesky: downloadBluesky };
  const results = [];
  for (const platform of options.platforms) {
    process.stdout.write(`Downloading ${platform}...\n`);
    try {
      const result = await downloaders[platform](options, capturedAt);
      const summary = await writePlatform(options.output, platform, result, options);
      results.push(summary);
      process.stdout.write(`  ${result.posts.length} posts fetched (${result.complete ? "complete" : `stopped: ${result.stopReason}`})\n`);
    } catch (error) {
      results.push({ platform, status: "error", error: error.message, complete: false, stopReason: error.threadsResult?.stopReason ?? "error", sessionKeptOpen: Boolean(error.keepSessionOpen) });
      process.stderr.write(`  ${platform} failed: ${error.message}\n`);
    }
  }
  const manifest = {
    schemaVersion: 1,
    capturedAt,
    requestedPlatforms: options.platforms,
    accounts: { twitter: "pedrovc", threads: options.threadsHandle, mastodon: "pedrovc@mastodon.social", bluesky: "pedro.vza.net" },
    filters: { since: options.since?.toISOString() ?? null, until: options.until?.toISOString() ?? null },
    results,
  };
  await writeFile(path.join(options.output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Archive written to ${options.output}\n`);
  if (results.some(result => result.status !== "ok") && !options.allowPartial) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error.message}\n${USAGE}`);
  process.exitCode = 1;
});
