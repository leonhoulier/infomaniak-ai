#!/usr/bin/env python3
"""Consistent online copies of the encrypted vault, without its encryption key."""
import argparse
import datetime
import os
from pathlib import Path
import re
import sqlite3
import stat
import time
from urllib.parse import quote


def private(path, directory=False):
    info = path.lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Backup paths must be private and owned by this user.")


def backup(state, destination, retention_days=7):
    if not state.is_absolute() or not destination.is_absolute() or retention_days < 1:
        raise ValueError("Use absolute paths and a positive retention period.")
    source = state / "hosted.sqlite"
    private(state, directory=True)
    private(source)
    if destination.resolve().is_relative_to(state.resolve()):
        raise ValueError("Keep backups outside the live state directory.")
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    private(destination, directory=True)
    name = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ.sqlite")
    target = destination / name
    temporary = destination / (name + ".partial")
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    try:
        original = sqlite3.connect("file:" + quote(str(source)) + "?mode=ro", uri=True, timeout=10)
        copied = sqlite3.connect(temporary)
        try:
            original.backup(copied, pages=128, sleep=0.1)
            if copied.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                raise ValueError("Backup integrity check failed.")
        finally:
            copied.close()
            original.close()
        with temporary.open("rb") as completed:
            os.fsync(completed.fileno())
        temporary.rename(target)
    finally:
        temporary.unlink(missing_ok=True)
    cutoff = time.time() - retention_days * 86400
    for old in destination.iterdir():
        if re.fullmatch(r"\d{8}T\d{12}Z\.sqlite", old.name):
            private(old)
            if old != target and old.stat().st_mtime < cutoff:
                old.unlink()
    print("Encrypted vault backup created and integrity checked: " + target.name)
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--backup-dir", type=Path, required=True)
    parser.add_argument("--retention-days", type=int, default=7)
    args = parser.parse_args()
    backup(args.state_dir, args.backup_dir, args.retention_days)
