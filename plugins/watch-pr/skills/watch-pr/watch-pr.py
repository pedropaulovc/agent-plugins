#!/usr/bin/env python3
"""Watch a pull request and emit lifecycle changes for an agent monitor."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from typing import Dict, Iterable, List, Optional, Set, Tuple


def use_utf8_streams() -> None:
    """Emit UTF-8 whatever the console codepage is.

    The watcher echoes review snippets verbatim, and a Windows console encoder set to
    cp1252 raises on the first emoji — the encode-side twin of the decode crash below.
    Whatever reads this pipe (Monitor, the OpenCode adapter) already decodes UTF-8.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8", errors="replace")


def command(*args: str, capture: bool = False, check: bool = False) -> subprocess.CompletedProcess:
    # gh and git speak UTF-8 on every platform, but text mode decodes captured output
    # with the *locale* codepage — cp1252 on a stock Windows box. One review body
    # carrying a byte that page leaves undefined used to raise UnicodeDecodeError in
    # the reader thread, hand back stdout=None, and take the watch down (issue #67).
    return subprocess.run(args, text=True, encoding="utf-8", errors="replace", capture_output=capture, check=check)


XML_COMMENT_PATTERN = re.compile(r"<!--.*?-->", re.DOTALL)
PENDING_CHECK_TIMESTAMP = "0001-01-01T00:00:00Z"
CHECK_FAILURE_BUCKETS = {"fail", "failure"}
CHECK_TERMINAL_BUCKETS = ("pass", "fail", "skipping", "cancel")

CheckKey = Tuple[str, int]
CheckState = Tuple[str, str, str]
CheckStates = Dict[CheckKey, CheckState]


def strip_xml_comments(value: str) -> str:
    """Remove hidden XML comments from text emitted to the monitor."""
    return XML_COMMENT_PATTERN.sub("", value)


def output(*args: str) -> str:
    result = command(*args, capture=True)
    # A failed capture yields None; callers all parse text, so degrade to an empty poll.
    return result.stdout or ""


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


def check_rows(number: int, slug: str) -> Optional[List[Dict[str, object]]]:
    result = command("gh", "pr", "checks", str(number), "-R", slug, "--json", "name,bucket,completedAt", capture=True)
    values = json_values(result.stdout or "")
    if not values:
        return None
    items: List[Dict[str, object]] = []
    for value in values:
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


SNAPSHOT_QUERY = """query($owner: String!, $repo: String!, $number: Int!, $threadCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      state mergeStateStatus baseRefName
      reviews(first: 100) { nodes { author { login } state submittedAt } }
      reactionGroups { content users { totalCount } }
      comments(first: 100) { nodes { author { login } } }
      reviewThreads(first: 100, after: $threadCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved }
      }
    }
  }
}"""


def pr_snapshot(slug: str, number: int) -> Tuple[Dict[str, object], Set[str]]:
    owner, repo = slug.split("/", 1)
    cursor: Optional[str] = None
    meta: Dict[str, object] = {}
    unresolved: Set[str] = set()

    while True:
        arguments = ["gh", "api", "graphql", "-f", f"owner={owner}", "-f", f"repo={repo}", "-F", f"number={number}", "-f", f"query={SNAPSHOT_QUERY}"]
        if cursor:
            arguments.extend(["-f", f"threadCursor={cursor}"])
        page = json_object(*arguments)
        try:
            pull_request = page["data"]["repository"]["pullRequest"]
            threads = pull_request["reviewThreads"]
        except (KeyError, TypeError):
            return {}, set()
        if not meta:
            meta = {
                "state": pull_request.get("state"),
                "mergeStateStatus": pull_request.get("mergeStateStatus"),
                "baseRefName": pull_request.get("baseRefName"),
                "reviews": (pull_request.get("reviews") or {}).get("nodes", []),
                "reactionGroups": pull_request.get("reactionGroups", []),
                "comments": (pull_request.get("comments") or {}).get("nodes", []),
            }
        unresolved.update(str(thread["id"]) for thread in threads.get("nodes", []) if not thread.get("isResolved"))
        page_info = threads.get("pageInfo") or {}
        if not page_info.get("hasNextPage"):
            return meta, unresolved
        cursor = page_info.get("endCursor")
        if not cursor:
            return meta, unresolved


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


def unresolved_delta_line(previous: Set[str], current: Set[str]) -> Optional[str]:
    added = len(current - previous)
    removed = len(previous - current)
    changes = [change for change in (f"+{added}" if added else "", f"-{removed}" if removed else "") if change]
    return f"unresolved-comments: {' '.join(changes)} (unresolved: {len(current)})" if changes else None


def check_state(check: Dict[str, object]) -> CheckState:
    name = str(check.get("name"))
    bucket = str(check.get("bucket") or "")
    finished = str(check.get("completedAt") or "")
    if bucket == "pending" and finished == PENDING_CHECK_TIMESTAMP:
        finished = ""
    return name, bucket, finished


def check_state_line(state: CheckState) -> str:
    name, bucket, finished = state
    return f"check {name}: {bucket}" + (f" @{finished}" if finished else "")


def check_states(checks: List[Dict[str, object]]) -> CheckStates:
    occurrences: Dict[str, int] = {}
    states: CheckStates = {}
    for check in checks:
        state = check_state(check)
        name = state[0]
        occurrence = occurrences.get(name, 0)
        states[(name, occurrence)] = state
        occurrences[name] = occurrence + 1
    return states


def check_terminal_summary(current: CheckStates) -> str:
    counts = {bucket: 0 for bucket in CHECK_TERMINAL_BUCKETS}
    other = 0
    for _, bucket, _ in current.values():
        if bucket in CHECK_FAILURE_BUCKETS:
            counts["fail"] += 1
        elif bucket in counts:
            counts[bucket] += 1
        else:
            other += 1
    details = ", ".join(f"{bucket}: {counts[bucket]}" for bucket in CHECK_TERMINAL_BUCKETS)
    if other:
        details += f", other: {other}"
    return f"checks: all terminal ({details})"


def check_event_lines(
    previous: Optional[CheckStates],
    current: CheckStates,
    rerun_active: bool,
) -> Tuple[List[str], bool]:
    failures = [
        check_state_line(state)
        for key, state in current.items()
        if state[1] in CHECK_FAILURE_BUCKETS and (previous is None or previous.get(key) != state)
    ]
    pending = {key for key, state in current.items() if state[1] == "pending"}
    started = sorted({
        state[0]
        for key, state in current.items()
        if state[1] == "pending" and (previous is None or previous.get(key, ("", "", ""))[1] != "pending")
    })
    events = sorted(set(failures))
    if started and not rerun_active:
        events.append(f"checks: rerun started (pending: {', '.join(started)})")
        rerun_active = True
    if rerun_active and not pending:
        previous_pending = {key for key, state in (previous or {}).items() if state[1] == "pending"}
        if previous_pending and not (previous_pending - current.keys()):
            events.append(check_terminal_summary(current))
        rerun_active = False
    return events, rerun_active


def state_lines(meta: Dict[str, object], checks: List[Dict[str, object]], slug: str, origin_matches: bool, me: str, review_comments: int, reactions: List[str]) -> List[str]:
    lines: List[str] = []
    for check in checks:
        lines.append(check_state_line(check_state(check)))
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
    for reaction in meta.get("reactionGroups") or []:
        users = reaction.get("users") or {}
        if users.get("totalCount", 0) > 0:
            lines.append(f"reaction {reaction.get('content')}: {users.get('totalCount')}")
    return sorted(lines + reactions)


def git_bash() -> Optional[str]:
    """Git for Windows' bash, located from the Git install `git` already resolves to."""
    roots: List[Path] = []
    exec_path = output("git", "--exec-path").strip()
    if exec_path:
        # …/Git/mingw64/libexec/git-core → the install root is a few levels up.
        roots.extend(Path(exec_path).parents)
    for variable in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
        base = os.environ.get(variable)
        if base:
            roots.extend([Path(base) / "Git", Path(base) / "Programs" / "Git"])
    for root in roots:
        candidate = root / "bin" / "bash.exe"
        if candidate.is_file():
            return str(candidate)
    return None


def bash_executable() -> str:
    """A bash that shares this process's filesystem namespace.

    On Windows the `bash` first on PATH is usually WSL's C:\\Windows\\System32\\bash.exe,
    which runs against a *different* filesystem: anything it writes under /tmp is
    unreachable from this native-Windows parent, so the formatter looked like it failed
    on every single poll (issue #63). Git for Windows' bash shares the Windows
    filesystem, so prefer it and let WATCH_PR_BASH override for unusual installs.
    """
    override = os.environ.get("WATCH_PR_BASH")
    if override:
        return override
    if os.name != "nt":
        return "bash"
    return git_bash() or "bash"


# A formatter that keeps failing gets a bounded number of retries per feedback event;
# after that the watcher goes quiet until genuinely new feedback arrives (issue #64).
FORMATTER_FAILURE_LIMIT = 3


def run_formatter(bash: str, script: Path, url: str, number: int, attempt: int) -> Optional[Path]:
    """Run comments.sh into a path THIS process picked, and hand that path back.

    The destination is chosen here rather than parsed out of the child's stdout: a
    POSIX path printed by an MSYS or WSL bash names a file this parent cannot open
    (issue #63). comments.sh takes the output file as its second argument, so both
    sides agree on the location by construction and no path translation is involved.
    """
    stamp = time.strftime("%Y%m%d-%H%M%S")
    destination = Path(tempfile.gettempdir()) / f"pr-comments-{number}-{stamp}-{attempt}.md"
    # as_posix() keeps the drive-letter path free of backslashes, which bash would
    # otherwise treat as escapes; MSYS resolves "C:/…" to the same Windows file.
    result = command(bash, str(script), url, destination.as_posix(), capture=True)
    if result.returncode != 0 or not destination.is_file() or not destination.stat().st_size:
        return None
    return destination


def formatter_lines(document: str) -> List[str]:
    lines: List[str] = []
    kind = ""
    thread: Dict[str, str] = {}
    snippet = ""

    def emit() -> None:
        if kind == "thread" and thread.get("id"):
            lines.append(f"feedback [{thread.get('id')}] {thread.get('file', '')}:{thread.get('lines', '')} @{thread.get('author', '')} {snippet}")

    for line in strip_xml_comments(document).splitlines():
        match = re.match(r"<(review-thread|pr-comment|review-summary) (.*)>", line)
        if match:
            emit(); kind = {"review-thread": "thread", "pr-comment": "comment", "review-summary": "summary"}[match.group(1)]
            thread = {}; snippet = ""; continue
        if line.startswith("## SUMMARY FOR LLM"):
            emit(); kind = ""; continue
        if kind == "thread":
            field = re.match(r"\| \*\*(ID|File|Lines|Author)\*\* \| `?(.*?)`? \|", line)
            if field:
                thread[field.group(1).lower()] = field.group(2)
        if kind == "thread" and not snippet and line.startswith("> "):
            candidate = line[2:].strip()
            if candidate:
                snippet = candidate[:100]
    return lines


def feedback_document_key(document: str) -> str:
    return re.sub(r"^fetched_at:.*$", "", document, flags=re.MULTILINE)


def main() -> int:
    use_utf8_streams()
    args = arguments()
    try:
        url, number, slug = pr_info(args.ref)
    except RuntimeError as error:
        print(f"watch-pr: {error}", file=sys.stderr)
        return 1
    origin_matches, me = origin_is_base(slug), login()
    comments_script, bash = Path(__file__).with_name("comments.sh"), bash_executable()
    previous: Set[str] = set()
    previous_check_states: Optional[CheckStates] = None
    check_rerun_active = False
    previous_unresolved: Set[str] = set()
    previous_feedback: Set[str] = set()
    previous_document = ""
    last_event = time.monotonic()
    pending_fetch, failures, fetches = False, 0, 0
    def emit(line: str) -> None:
        nonlocal last_event
        line = strip_xml_comments(line).strip()
        if not line:
            return
        print(line, flush=True); last_event = time.monotonic()
    while True:
        meta, unresolved = pr_snapshot(slug, number)
        check_snapshot = check_rows(number, slug)
        checks = check_snapshot or []
        review_comments = [item for item in json_array("gh", "api", "--paginate", f"repos/{slug}/pulls/{number}/comments") if (item.get("user") or {}).get("login") != me]
        current_check_states = previous_check_states if check_snapshot is None else check_states(check_snapshot)
        current = set(state_lines(meta, checks, slug, origin_matches, me, len(review_comments), comment_reactions(slug, number, me)))
        added = current - previous
        unresolved_delta = unresolved_delta_line(previous_unresolved, unresolved)
        unresolved_added = unresolved - previous_unresolved
        if unresolved_added or any(line.startswith(("review ", "comments: ", "review-comments: ")) for line in added):
            # Fresh feedback: owe a fetch, and hand the formatter a clean retry budget.
            pending_fetch, failures = True, 0
        check_lines = {line for line in added if line.startswith("check ")}
        for line in sorted(added - check_lines):
            emit(line)
        check_events = []
        if check_snapshot is not None:
            check_events, check_rerun_active = check_event_lines(previous_check_states, current_check_states or {}, check_rerun_active)
        for line in check_events:
            emit(line)
        if unresolved_delta:
            emit(unresolved_delta)
        # Advance unconditionally. Holding the baseline back on a failed fetch used to
        # re-emit the whole state block every poll forever, since the only path that
        # could advance it was the broken one — enough output for Monitor to auto-stop
        # the watcher (issue #64). The outstanding fetch rides on pending_fetch instead,
        # so it still retries without duplicating events that already went out.
        previous, previous_check_states, previous_unresolved = current, current_check_states, unresolved
        if pending_fetch and failures < FORMATTER_FAILURE_LIMIT:
            fetches += 1
            path = run_formatter(bash, comments_script, url, number, fetches)
            if path is None:
                failures += 1
                if failures == 1:
                    emit("watch-pr: comment formatter failed — will retry next poll")
                elif failures >= FORMATTER_FAILURE_LIMIT:
                    emit(f"watch-pr: comment formatter failed {failures}× — pausing retries until new feedback arrives")
            else:
                pending_fetch, failures = False, 0
                document = path.read_text(encoding="utf-8")
                active = re.search(r"^active_comments:\s*(\d+)", document, re.M)
                current_feedback = set(formatter_lines(document))
                document_key = feedback_document_key(document)
                has_feedback = (active and int(active.group(1)) > 0) or "<review-summary" in document
                if has_feedback:
                    new_feedback = sorted(current_feedback - previous_feedback)
                    if new_feedback or document_key != previous_document:
                        for line in new_feedback: emit(line)
                        emit(f"→ full bodies + code context: {path}")
                previous_feedback, previous_document = current_feedback, document_key
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
