#!/usr/bin/env python3
"""
Build script: cross-compiles the mediocrity-detector Rust binary for
Linux x86_64 and Windows x86_64, then copies the outputs to hooks/bin/.

Run after any change to the Rust source or when bumping the plugin version.

Prerequisites:
  - Rust toolchain with targets:
      rustup target add x86_64-unknown-linux-gnu
      rustup target add x86_64-pc-windows-msvc
  - On Windows: cargo-zigbuild + zig for Linux cross-compilation:
      cargo install cargo-zigbuild
      uv tool install ziglang
  - On Linux: cargo-xwin for Windows cross-compilation:
      cargo install cargo-xwin
"""
import os
import platform
import shutil
import stat
import subprocess
import sys

HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
BIN_DIR = os.path.join(HOOKS_DIR, 'bin')

IS_WINDOWS = platform.system() == 'Windows'

PLATFORM_TARGETS = [
    {'triple': 'x86_64-unknown-linux-gnu', 'ext': '', 'cmd': 'zigbuild' if IS_WINDOWS else 'build'},
    {'triple': 'x86_64-pc-windows-msvc', 'ext': '.exe', 'cmd': 'build' if IS_WINDOWS else 'xwin build'},
]

CRATES = ['mediocrity-detector']


def build_target(crate_dir: str, triple: str, cmd: str = 'build') -> None:
    print(f"Building for {triple} (cargo {cmd})...")
    subprocess.run(
        ['cargo', *cmd.split(), '--release', '--target', triple],
        cwd=crate_dir,
        check=True,
    )


def copy_binary(crate_dir: str, crate_name: str, triple: str, ext: str) -> None:
    src = os.path.join(crate_dir, 'target', triple, 'release', crate_name + ext)
    dst = os.path.join(BIN_DIR, crate_name + ext)
    os.makedirs(BIN_DIR, exist_ok=True)
    shutil.copy2(src, dst)
    os.chmod(dst, os.stat(dst).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    if not ext:
        subprocess.run(['git', 'update-index', '--chmod=+x', dst], check=False)
    print(f"Copied {src} -> {dst}")


def main() -> None:
    for crate_name in CRATES:
        crate_dir = os.path.join(HOOKS_DIR, crate_name)
        for target in PLATFORM_TARGETS:
            try:
                build_target(crate_dir, target['triple'], target['cmd'])
                copy_binary(crate_dir, crate_name, target['triple'], target['ext'])
            except subprocess.CalledProcessError:
                print(f"WARNING: failed to build {crate_name} for {target['triple']}, skipping", file=sys.stderr)
                continue

    print("Done.")


if __name__ == '__main__':
    main()
