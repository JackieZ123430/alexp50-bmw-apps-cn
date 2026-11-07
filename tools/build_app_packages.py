#!/usr/bin/env python3
"""Package built apps from dist/<id>/source for MGU Store releases."""

from __future__ import annotations

import gzip
import io
import json
import pathlib
import sys
import tarfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
PACKAGES = ROOT / "packages"


def add_path(tf: tarfile.TarFile, source: pathlib.Path, archive: str) -> None:
    info = tarfile.TarInfo(archive)
    stat = source.stat()
    info.mtime = 0
    info.uid = info.gid = 0
    info.uname = info.gname = "root"
    if source.is_dir():
        info.type = tarfile.DIRTYPE
        info.mode = 0o755
        tf.addfile(info)
        return
    info.mode = 0o755 if stat.st_mode & 0o111 else 0o644
    info.size = stat.st_size
    with source.open("rb") as stream:
        tf.addfile(info, stream)


def build(app_id: str) -> pathlib.Path:
    source = DIST / app_id / "source"
    manifest_path = source / "package.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"Build {app_id} first; missing {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("name") != app_id:
        raise ValueError(f"Package name mismatch for {app_id}")
    version = manifest["version"]
    PACKAGES.mkdir(exist_ok=True)
    output = PACKAGES / f"{app_id}@{version}.tgz"

    for stale in PACKAGES.glob(f"{app_id}@*.tgz"):
        if stale != output:
            stale.unlink()

    entries = sorted(source.rglob("*"), key=lambda path: path.relative_to(source).as_posix())
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tf:
        root = tarfile.TarInfo("package")
        root.type = tarfile.DIRTYPE
        root.mode = 0o755
        root.mtime = 0
        root.uid = root.gid = 0
        root.uname = root.gname = "root"
        tf.addfile(root)
        for path in entries:
            add_path(tf, path, "package/" + path.relative_to(source).as_posix())

    with output.open("wb") as stream:
        with gzip.GzipFile(filename="", mode="wb", fileobj=stream, mtime=0) as gz:
            gz.write(raw.getvalue())
    print(f"{app_id} {version}: {output.name} ({output.stat().st_size} bytes)")
    return output


def main() -> None:
    app_ids = sys.argv[1:]
    if not app_ids:
        raise SystemExit("Usage: build_app_packages.py <app-id> [<app-id> ...]")
    for app_id in app_ids:
        build(app_id)


if __name__ == "__main__":
    main()
