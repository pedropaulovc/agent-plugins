#!/usr/bin/env python3
"""Pack the marketplace's pure-skill plugins into Claude Desktop skill zips and
publish them as a GitHub release.

A "pure-skill" plugin is one that ships a ``skills/`` directory and no
``hooks/`` directory — i.e. everything it does ports cleanly to Claude Desktop /
claude.ai, which imports one skill (a folder with a ``SKILL.md``) per ``.zip``.
That rule selects: alt-text, gh-issue, gstack-entrepreneur, pr-comments,
worktree-reset, and developing-solidworks (it has a ``commands/`` helper but no
hooks). Every skill directory becomes its own ``<skill>.zip`` whose single
top-level folder is the skill, so the archive drops straight into Desktop.

developing-solidworks is special: its SKILL.md navigates a large offline API
reference that is *not* checked into this repo (it is git-ignored and fetched at
runtime from a separate releases repo). To make the Desktop skill self-contained
we download that documentation bundle and bake it into the zip.

Only tracked files are staged (via ``git ls-files``), so a developer's locally
downloaded docs never leak into a build — the bundle is always fetched fresh.

Usage:
    python3 scripts/pack-skills.py                 # build + publish a new release
    python3 scripts/pack-skills.py --no-upload     # just build the zips into dist/
    python3 scripts/pack-skills.py --no-docs       # skip the SolidWorks bundle (fast)
    python3 scripts/pack-skills.py --tag skills-v1 --draft

Requires: git, gh (authenticated). No third-party Python packages.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

# Plugins that carry a documentation bundle to bake into the zip. Keyed by
# plugin name; each entry names the skill folder that consumes the docs and the
# releases repo + asset glob to pull them from.
DOCS_BUNDLES = {
    "developing-solidworks": {
        "skill": "developing-solidworks",
        "repo": "pedropaulovc/offline-solidworks-api-docs",
        "asset_glob": "SolidWorks.Interop.llms.v*.zip",
    },
}

# Never ship these into a skill zip even if tracked.
EXCLUDE_NAMES = {".gitignore", ".bundle-version", ".DS_Store"}


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    """Run a command, echoing it, and raise on failure unless capture is asked."""
    print(f"  $ {' '.join(cmd)}", file=sys.stderr)
    return subprocess.run(cmd, check=True, text=True, **kw)


def repo_root() -> Path:
    out = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        check=True, text=True, capture_output=True,
    ).stdout.strip()
    return Path(out)


def detect_repo(root: Path) -> str:
    """OWNER/REPO for the current origin remote (via gh)."""
    out = subprocess.run(
        ["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
        cwd=root, check=True, text=True, capture_output=True,
    ).stdout.strip()
    return out


def is_pure_skill(plugin_dir: Path) -> bool:
    return (plugin_dir / "skills").is_dir() and not (plugin_dir / "hooks").is_dir()


def discover(root: Path) -> list[tuple[str, str, Path]]:
    """Return (plugin, skill, skill_dir) for every skill in every pure-skill plugin."""
    found: list[tuple[str, str, Path]] = []
    for plugin_dir in sorted((root / "plugins").iterdir()):
        if not plugin_dir.is_dir() or not is_pure_skill(plugin_dir):
            continue
        for skill_dir in sorted((plugin_dir / "skills").iterdir()):
            if (skill_dir / "SKILL.md").is_file():
                found.append((plugin_dir.name, skill_dir.name, skill_dir))
    return found


def tracked_files(root: Path, skill_dir: Path) -> list[Path]:
    rel = skill_dir.relative_to(root)
    out = subprocess.run(
        ["git", "ls-files", "-z", "--", str(rel)],
        cwd=root, check=True, text=True, capture_output=True,
    ).stdout
    return [root / p for p in out.split("\0") if p]


def stage_skill(root: Path, skill_dir: Path, dest: Path) -> None:
    """Copy the skill's tracked files into dest/<skillname>/, minus excludes."""
    for src in tracked_files(root, skill_dir):
        if src.name in EXCLUDE_NAMES:
            continue
        target = dest / src.relative_to(skill_dir)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)


def bundle_version(repo: str, docs_tag: str) -> str:
    if docs_tag == "latest":
        cmd = ["gh", "api", f"repos/{repo}/releases/latest", "-q", ".tag_name"]
    else:
        cmd = ["gh", "release", "view", docs_tag, "-R", repo,
               "--json", "tagName", "-q", ".tagName"]
    return subprocess.run(
        cmd, check=True, text=True, capture_output=True,
    ).stdout.strip()


def add_docs_bundle(spec: dict, staged: Path, docs_tag: str) -> str:
    """Download the docs asset and extract it into the staged skill dir.

    Returns the resolved bundle version tag.
    """
    repo = spec["repo"]
    version = bundle_version(repo, docs_tag)
    print(f"  bundling {repo} docs {version} -> {staged.name}", file=sys.stderr)
    with tempfile.TemporaryDirectory() as td:
        run(["gh", "release", "download", version, "-R", repo,
             "-p", spec["asset_glob"], "-D", td])
        zips = list(Path(td).glob(spec["asset_glob"]))
        if not zips:
            raise SystemExit(f"no asset matching {spec['asset_glob']} in {repo} {version}")
        with zipfile.ZipFile(zips[0]) as zf:
            zf.extractall(staged)
    (staged / ".bundle-version").write_text(version)
    return version


def sanitize_component(comp: str) -> str:
    """Map a single path component to the charset the Claude Desktop skill
    uploader accepts. It rejects paths with characters outside a conservative
    set (spaces, commas, apostrophes, ``#``, ``%``, ``+``, ``()`` all trip it).

    Language tokens are spelled out first so they survive as readable, distinct
    names (``C#`` -> ``csharp``, ``C++`` -> ``cpp``) instead of folding to
    ``C_``/``C__``. Everything else disallowed becomes ``_``, one-for-one (not
    collapsed). Leading/trailing underscores are preserved because
    ``_overview.md`` is a load-bearing name the skill greps for verbatim.
    """
    comp = comp.replace("C++", "cpp").replace("C#", "csharp")
    return re.sub(r"[^A-Za-z0-9._-]", "_", comp)


def make_zip(staged: Path, skill: str, out_zip: Path) -> int:
    """Zip staged/ so the archive's single top-level entry is <skill>/.

    Every path component is sanitized to the uploader's charset. Returns the
    number of entries whose path had to be rewritten.
    """
    out_zip.parent.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in staged.rglob("*") if p.is_file())
    used: set[str] = set()
    renamed = 0
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            rel = f.relative_to(staged).as_posix()
            safe_rel = "/".join(sanitize_component(c) for c in rel.split("/"))
            if safe_rel != rel:
                renamed += 1
            arcname = f"{skill}/{dedupe(safe_rel, used)}"
            zf.write(f, arcname)
    return renamed


def dedupe(rel: str, used: set[str]) -> str:
    """Ensure rel is unique within used, inserting -1/-2/... before the suffix
    when two source names sanitize to the same string (e.g. upstream ships both
    an apostrophe and an underscore variant of one example)."""
    if rel not in used:
        used.add(rel)
        return rel
    stem, dot, ext = rel.rpartition(".")
    base = stem if dot else rel
    suffix = f".{ext}" if dot else ""
    i = 1
    while f"{base}-{i}{suffix}" in used:
        i += 1
    out = f"{base}-{i}{suffix}"
    used.add(out)
    return out


def build(root: Path, dist: Path, want_docs: bool, docs_tag: str) -> dict:
    skills = discover(root)
    if not skills:
        raise SystemExit("no pure-skill plugins found under plugins/")

    seen: dict[str, str] = {}
    for _, skill, _ in skills:
        if skill in seen:
            raise SystemExit(
                f"skill name collision: '{skill}' in both {seen[skill]} and this plugin; "
                "asset filenames must be unique"
            )
    for plugin, skill, _ in skills:
        seen[skill] = plugin

    if dist.exists():
        shutil.rmtree(dist)
    dist.mkdir(parents=True)

    manifest = {"skills": [], "docs_bundles": {}}
    with tempfile.TemporaryDirectory() as build_root:
        for plugin, skill, skill_dir in skills:
            staged = Path(build_root) / plugin / skill
            stage_skill(root, skill_dir, staged)

            spec = DOCS_BUNDLES.get(plugin)
            if spec and spec["skill"] == skill:
                if want_docs:
                    ver = add_docs_bundle(spec, staged, docs_tag)
                    manifest["docs_bundles"][skill] = ver
                else:
                    print(f"  (skipping docs bundle for {skill})", file=sys.stderr)

            out_zip = dist / f"{skill}.zip"
            renamed = make_zip(staged, skill, out_zip)
            size = out_zip.stat().st_size
            manifest["skills"].append({
                "plugin": plugin, "skill": skill,
                "zip": out_zip.name, "size": size,
                "version": plugin_version(root, plugin),
            })
            extra = f", {renamed} path(s) sanitized" if renamed else ""
            print(f"  packed {out_zip.name}  ({size/1024:.0f} KiB{extra})", file=sys.stderr)
    return manifest


def plugin_version(root: Path, plugin: str) -> str:
    for cand in (
        root / "plugins" / plugin / "plugin.json",
        root / "plugins" / plugin / ".claude-plugin" / "plugin.json",
    ):
        if cand.is_file():
            return json.loads(cand.read_text()).get("version", "?")
    return "?"


def release_notes(manifest: dict) -> str:
    lines = [
        "Importable Claude Desktop / claude.ai skill bundles, one `.zip` per skill.",
        "Download a zip and add it under **Settings → Capabilities → Skills**.",
        "",
        "| Skill | Plugin | Version | Size |",
        "| --- | --- | --- | --- |",
    ]
    for s in manifest["skills"]:
        lines.append(
            f"| `{s['skill']}` | {s['plugin']} | {s['version']} | {s['size']/1024:.0f} KiB |"
        )
    if manifest["docs_bundles"]:
        lines.append("")
        for skill, ver in manifest["docs_bundles"].items():
            lines.append(f"> `{skill}` includes the SolidWorks API documentation bundle **{ver}**.")
    return "\n".join(lines)


def publish(root: Path, repo: str, tag: str, title: str, notes: str,
            dist: Path, draft: bool) -> None:
    zips = sorted(str(p) for p in dist.glob("*.zip"))
    cmd = ["gh", "release", "create", tag, "-R", repo,
           "--title", title, "--notes", notes, "--target", "main"]
    if draft:
        cmd.append("--draft")
    cmd += zips
    run(cmd, cwd=root)
    print(f"\nReleased {tag} to {repo} with {len(zips)} skill zip(s).", file=sys.stderr)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tag", help="release tag (default: skills-<UTC timestamp>)")
    ap.add_argument("--title", help="release title (default: same as tag)")
    ap.add_argument("--notes", help="release notes (default: auto-generated table)")
    ap.add_argument("--dist", default="dist/skills", help="output dir for zips")
    ap.add_argument("--repo", help="OWNER/REPO to release to (default: origin)")
    ap.add_argument("--docs-tag", default="latest",
                    help="docs release tag to bundle (default: latest)")
    ap.add_argument("--no-docs", action="store_true",
                    help="skip baking in documentation bundles")
    ap.add_argument("--no-upload", action="store_true",
                    help="build zips only; do not create a release")
    ap.add_argument("--draft", action="store_true", help="create the release as a draft")
    args = ap.parse_args()

    root = repo_root()
    dist = (root / args.dist).resolve() if not Path(args.dist).is_absolute() else Path(args.dist)

    print("Discovering pure-skill plugins...", file=sys.stderr)
    manifest = build(root, dist, want_docs=not args.no_docs, docs_tag=args.docs_tag)

    if args.no_upload:
        print(f"\nBuilt {len(manifest['skills'])} zip(s) into {dist}. Skipping upload.",
              file=sys.stderr)
        return

    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
    tag = args.tag or f"skills-{stamp}"
    title = args.title or tag
    notes = args.notes or release_notes(manifest)
    repo = args.repo or detect_repo(root)
    publish(root, repo, tag, title, notes, dist, args.draft)


if __name__ == "__main__":
    main()
