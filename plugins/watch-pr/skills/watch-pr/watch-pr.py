#!/usr/bin/env python3
"""Watch a pull request and emit lifecycle changes for an agent monitor."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from typing import Dict, Iterable, List, Optional, Set, Tuple


def command(*args: str, capture: bool = False, check: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(args, text=True, capture_output=capture, check=check)


def output(*args: str) -> str:
    result = command(*args, capture=True)
    return result.stdout if result.returncode == 0 else ""


def json_values(value: str) -> List[object]:
    decoder = json.JSONDecoder()
    values: List[object] = []
    position = 0
    while position < len(value):
        whitespace = re.match(r"\s*", value[position:])
        position += whitespace.end() if whitespace else 0
        if position >= len(value):
            break
        try:
            parsed, position = decoder.raw_decode(value, position)
        except json.JSONDecodeError:
            return []
        values.append(parsed)
    return values


def json_object(*args: str) -> Dict[str, object]:
    values = json_values(output(*args))
    return values[0] if values and isinstance(values[0], dict) else {}


def json_array(*args: str) -> List[Dict[str, object]]:
    items: List[Dict[str, object]] = []
    for value in json_values(output(*args)):
        if isinstance(value, list):
            items.extend(item for item in value if isinstance(item, dict))
    return items


def parse_duration(value: str) -> int:
    match = re.fullmatch(r"([1-9][0-9]*)([smhd])", value)
    if not match:
        raise argparse.ArgumentTypeError("must be a positive duration ending in s, m, h, or d (for example: 30m or 2h)")
    return int(match.group(1)) * {"s": 1, "m": 60, "h": 3600, "d": 86400}[match.group(2)]


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(usage="watch-pr.py <pr-number|url|branch> [--stall-timeout <duration>]", add_help=False)
    parser.add_argument("ref", nargs="?")
    parser.add_argument("--stall-timeout", default="1h")
    parser.add_argument("-h", "--help", action="help")
    args = parser.parse_args()
    if not args.ref:
        parser.error("a PR ref is required")
    try:
        args.stall_seconds = parse_duration(args.stall_timeout)
    except argparse.ArgumentTypeError as error:
        parser.error(f"--stall-timeout {error}")
    poll = os.environ.get("WATCH_PR_POLL_SECONDS", "30")
    if not re.fullmatch(r"[1-9][0-9]*", poll):
        parser.error("WATCH_PR_POLL_SECONDS must be a positive integer")
    args.poll_seconds = int(poll)
    return args


def pr_info(ref: str) -> Tuple[str, int, str]:
    info = json_object("gh", "pr", "view", ref, "--json", "url,number")
    url = info.get("url")
    number = info.get("number")
    match = re.fullmatch(r"https?://github\.com/([^/]+)/([^/]+)/pull/(\d+)/?", str(url or ""))
    if not match or not isinstance(number, int):
        raise RuntimeError(f"cannot resolve PR ref '{ref}' — pass a PR number, URL, or branch name")
    return str(url), number, f"{match.group(1)}/{match.group(2)}"


def origin_is_base(slug: str) -> bool:
    origin = output("git", "remote", "get-url", "origin").strip()
    match = re.search(r"github\.com[:/]([^/]+)/([^/.]+)(?:\.git)?$", origin)
    return bool(match and f"{match.group(1)}/{match.group(2)}" == slug)


def login() -> str:
    return output("gh", "api", "user", "--jq", ".login").strip()


def unresolved_ids(slug: str, number: int) -> Set[str]:
    query = """query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $pr) {
    reviewThreads(first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { id isResolved } }
  } }
}"""
    result = output("gh", "api", "graphql", "--paginate", "-f", f"owner={slug.split('/', 1)[0]}", "-f", f"repo={slug.split('/', 1)[1]}", "-F", f"pr={number}", "-f", f"query={query}")
    ids: Set[str] = set()
    for page in json_values(result):
        try:
            threads = page["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"]
        except (KeyError, TypeError):
            continue
        ids.update(str(thread["id"]) for thread in threads if not thread.get("isResolved"))
    return ids


def comment_reactions(slug: str, number: int, me: str) -> List[str]:
    lines: List[str] = []
    comments = json_array("gh", "api", "--paginate", f"repos/{slug}/issues/{number}/comments")
    counts: Dict[str, int] = {}
    for comment in comments:
        reactions = comment.get("reactions") or {}
        if not isinstance(reactions, dict) or not reactions.get("total_count"):
            continue
        for reaction in json_array("gh", "api", "--paginate", f"repos/{slug}/issues/comments/{comment.get('id')}/reactions"):
            user = reaction.get("user") or {}
            if isinstance(user, dict) and user.get("login") == me:
                continue
            content = str(reaction.get("content", ""))
            counts[content] = counts.get(content, 0) + 1
    names = {"+1": "THUMBS_UP", "-1": "THUMBS_DOWN", "eyes": "EYES", "laugh": "LAUGH", "hooray": "HOORAY", "confused": "CONFUSED", "heart": "HEART", "rocket": "ROCKET"}
    return [f"comment-reaction {names.get(content, content)}: {count}" for content, count in sorted(counts.items())]


def state_lines(meta: Dict[str, object], checks: List[Dict[str, object]], slug: str, origin_matches: bool, me: str, review_comments: int, unresolved: int, reactions: List[str]) -> List[str]:
    lines: List[str] = []
    for check in checks:
        finished = check.get("completedAt") or ""
        lines.append(f"check {check.get('name')}: {check.get('bucket')}" + (f" @{finished}" if finished else ""))
    status = meta.get("mergeStateStatus")
    if status in ("BEHIND", "DIRTY"):
        base = meta.get("baseRefName")
        hint = f"git pull --rebase origin {base}" if origin_matches else f"base is {slug}:{base}; local origin ≠ base repo — rebase against the base remote, not origin"
        lines.append(f"rebase: {status} — {hint} (BEHIND=fast-forward, DIRTY=resolve conflicts)")
    for review in meta.get("reviews") or []:
        author = review.get("author") or {}
        if author.get("login") != me:
            lines.append(f"review {author.get('login')}: {review.get('state')} @{review.get('submittedAt')}")
    comments = [comment for comment in meta.get("comments") or [] if (comment.get("author") or {}).get("login") != me]
    lines.append(f"comments: {len(comments)}")
    lines.append(f"review-comments: {review_comments}")
    lines.append(f"unresolved-threads: {unresolved}")
    for reaction in meta.get("reactionGroups") or []:
        users = reaction.get("users") or {}
        if users.get("totalCount", 0) > 0:
            lines.append(f"reaction {reaction.get('content')}: {users.get('totalCount')}")
    return sorted(lines + reactions)


def formatter_lines(path: Path) -> List[str]:
    lines: List[str] = []
    kind = ""
    attrs: Dict[str, str] = {}
    thread: Dict[str, str] = {}
    snippet = ""
    def emit() -> None:
        if kind == "thread" and thread.get("id"):
            lines.append(f"feedback [{thread.get('id')}] {thread.get('file', '')}:{thread.get('lines', '')} @{thread.get('author', '')} {snippet}")
        if kind == "comment":
            lines.append(f"feedback comment [{attrs.get('id', '')}] @{attrs.get('author', '')} {snippet}")
        if kind == "summary":
            lines.append(f"feedback review [{attrs.get('id', '')}] @{attrs.get('author', '')} {snippet}")
    for line in path.read_text().splitlines():
        match = re.match(r"<(review-thread|pr-comment|review-summary) (.*)>", line)
        if match:
            emit(); kind = {"review-thread": "thread", "pr-comment": "comment", "review-summary": "summary"}[match.group(1)]
            attrs = dict(re.findall(r'(\w+)="([^"]*)"', match.group(2))); thread = {}; snippet = ""; continue
        if line.startswith("## SUMMARY FOR LLM"):
            emit(); kind = ""; continue
        if kind == "thread":
            field = re.match(r"\| \*\*(ID|File|Lines|Author)\*\* \| `?(.*?)`? \|", line)
            if field:
                thread[field.group(1).lower()] = field.group(2)
        if kind and not snippet and line.startswith("> "):
            snippet = line[2:].strip()[:100]
    emit()
    return lines


def main() -> int:
    args = arguments()
    try:
        url, number, slug = pr_info(args.ref)
    except RuntimeError as error:
        print(f"watch-pr: {error}", file=sys.stderr)
        return 1
    origin_matches, me = origin_is_base(slug), login()
    comments_script = Path(__file__).with_name("comments.sh")
    previous: Set[str] = set(); previous_unresolved: Set[str] = set(); last_event = time.monotonic()
    def emit(line: str) -> None:
        nonlocal last_event
        print(line, flush=True); last_event = time.monotonic()
    while True:
        meta = json_object("gh", "pr", "view", str(number), "-R", slug, "--json", "state,mergeStateStatus,baseRefName,reviews,reactionGroups,comments")
        checks = json_array("gh", "pr", "checks", str(number), "-R", slug, "--json", "name,bucket,completedAt")
        review_comments = [item for item in json_array("gh", "api", "--paginate", f"repos/{slug}/pulls/{number}/comments") if (item.get("user") or {}).get("login") != me]
        unresolved = unresolved_ids(slug, number)
        current = set(state_lines(meta, checks, slug, origin_matches, me, len(review_comments), len(unresolved), comment_reactions(slug, number, me)))
        added, unresolved_added = current - previous, unresolved - previous_unresolved
        fetch = bool(unresolved_added or any(line.startswith(("review ", "comments: ", "review-comments: ")) for line in added))
        for line in sorted(added): emit(line)
        advance = True
        if fetch:
            display_path = output("bash", str(comments_script), url).strip()
            path = Path(display_path)
            if shutil.which("cygpath") and display_path:
                converted = output("cygpath", "-u", display_path).strip()
                path = Path(converted or display_path)
            if not display_path or not path.is_file():
                emit("watch-pr: comment formatter failed — will retry next poll"); advance = False
            else:
                active = re.search(r"^active_comments:\s*(\d+)", path.read_text(), re.M)
                if (active and int(active.group(1)) > 0) or "<review-summary" in path.read_text():
                    for line in formatter_lines(path): emit(line)
                    emit(f"→ full bodies + code context: {display_path}")
        if advance:
            previous, previous_unresolved = current, unresolved
        state = str(meta.get("state", ""))
        if state in ("MERGED", "CLOSED"):
            if state == "MERGED":
                emit("merged — running git fetch"); command("git", "fetch", "--all", "--prune")
            break
        if time.monotonic() - last_event >= args.stall_seconds:
            emit(f"stall: no new events for {args.stall_timeout} — watcher still running")
        time.sleep(args.poll_seconds)
    emit(f"PR {number} finished: {state}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
