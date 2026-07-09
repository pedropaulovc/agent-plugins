#!/usr/bin/env python3
"""Build the memory-to-repo native hook for Linux and Windows x86_64."""

import json
import os
import platform
import shutil
import stat
import subprocess
import sys

HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
BIN_DIR = os.path.join(HOOKS_DIR, "bin")
CRATE_NAME = "memory-to-repo"
IS_WINDOWS = platform.system() == "Windows"

PLATFORM_TARGETS = [
    {
        "triple": "x86_64-unknown-linux-gnu",
        "ext": "",
        "cmd": "zigbuild" if IS_WINDOWS else "build",
    },
    {
        "triple": "x86_64-pc-windows-msvc",
        "ext": ".exe",
        "cmd": "build" if IS_WINDOWS else "xwin build",
    },
]


def build_target(crate_dir: str, triple: str, command: str) -> None:
    print(f"Building for {triple} (cargo {command})...")
    subprocess.run(
        ["cargo", *command.split(), "--release", "--target", triple],
        cwd=crate_dir,
        check=True,
    )


def target_dir(crate_dir: str) -> str:
    result = subprocess.run(
        ["cargo", "metadata", "--format-version", "1", "--no-deps"],
        cwd=crate_dir,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)["target_directory"]


def copy_binary(crate_dir: str, triple: str, extension: str) -> None:
    source = os.path.join(
        target_dir(crate_dir), triple, "release", CRATE_NAME + extension
    )
    destination = os.path.join(BIN_DIR, CRATE_NAME + extension)
    os.makedirs(BIN_DIR, exist_ok=True)
    shutil.copy2(source, destination)
    os.chmod(
        destination,
        os.stat(destination).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH,
    )
    if not extension:
        subprocess.run(
            ["git", "update-index", "--add", "--chmod=+x", destination], check=True
        )
    print(f"Copied {source} -> {destination}")


def main() -> None:
    crate_dir = os.path.join(HOOKS_DIR, CRATE_NAME)
    failed = False
    for target in PLATFORM_TARGETS:
        try:
            build_target(crate_dir, target["triple"], target["cmd"])
            copy_binary(crate_dir, target["triple"], target["ext"])
        except subprocess.CalledProcessError:
            failed = True
            print(
                f"ERROR: failed to build {CRATE_NAME} for {target['triple']}",
                file=sys.stderr,
            )
    if failed:
        raise SystemExit(1)
    print("Done.")


if __name__ == "__main__":
    main()
