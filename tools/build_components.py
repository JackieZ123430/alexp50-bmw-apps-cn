#!/usr/bin/env python3
"""Build mgu-deploy tool artifacts from components/*/component.json."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import pathlib
import sys
import tarfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
COMPONENTS = ROOT / "components"
PACKAGES = ROOT / "packages"


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def add_bytes(tf: tarfile.TarFile, name: str, data: bytes, mode: int = 0o644) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = mode
    info.mtime = 0
    info.uid = info.gid = 0
    info.uname = info.gname = "root"
    tf.addfile(info, io.BytesIO(data))


def build(folder: pathlib.Path) -> pathlib.Path:
    source = json.loads((folder / "component.json").read_text(encoding="utf-8"))
    component = dict(source)

    files = []
    payloads: list[tuple[str, pathlib.Path, int]] = []
    for entry in source.get("files", []):
        item = dict(entry)
        relative = pathlib.Path(item.pop("from", pathlib.Path("files") / item["path"]))
        path = folder / relative
        mode = int(str(item.get("mode", "0644")), 8)
        item["mode"] = f"{mode:04o}"
        item["sha256"] = digest(path)
        files.append(item)
        payloads.append((f"files/{item['path']}", path, mode))
    component["files"] = files

    units = []
    for entry in source.get("units", []):
        item = dict(entry)
        relative = pathlib.Path(item.pop("from", pathlib.Path("units") / item["name"]))
        units.append(item)
        payloads.append((f"units/{item['name']}", folder / relative, 0o644))
    if units:
        component["units"] = units

    dropins = []
    for entry in source.get("dropins", []):
        item = dict(entry)
        relative = pathlib.Path(item.pop("from", pathlib.Path("dropins") / item["name"]))
        dropins.append(item)
        payloads.append((f"dropins/{item['unit']}.d/{item['name']}", folder / relative, 0o644))
    if dropins:
        component["dropins"] = dropins

    PACKAGES.mkdir(exist_ok=True)
    output = PACKAGES / f"{component['id']}@{component['version']}.tgz"
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tf:
        add_bytes(tf, "component.json", (json.dumps(component, indent=2) + "\n").encode())
        for archive_name, path, mode in sorted(payloads):
            if not path.is_file():
                raise FileNotFoundError(path)
            add_bytes(tf, archive_name, path.read_bytes(), mode)
    with output.open("wb") as stream:
        with gzip.GzipFile(filename="", mode="wb", fileobj=stream, mtime=0) as gz:
            gz.write(raw.getvalue())
    print(f"{component['id']} {component['version']}: {output.name} ({output.stat().st_size} bytes)")
    return output


def main() -> None:
    wanted = set(sys.argv[1:])
    folders = sorted(p for p in COMPONENTS.iterdir() if p.is_dir() and (p / "component.json").is_file())
    if wanted:
        folders = [p for p in folders if p.name in wanted]
        missing = wanted - {p.name for p in folders}
        if missing:
            raise SystemExit(f"Unknown components: {', '.join(sorted(missing))}")
    for folder in folders:
        build(folder)


if __name__ == "__main__":
    main()
