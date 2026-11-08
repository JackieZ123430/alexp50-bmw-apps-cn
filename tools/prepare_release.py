#!/usr/bin/env python3
"""Create the Store catalog, metadata and release notes from packages/*.tgz."""

from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import subprocess
import tarfile
import urllib.parse


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKAGES = os.path.join(ROOT, "packages")
REPOSITORY = os.environ.get("GITHUB_REPOSITORY", "alexp50/bmw-apps")
APP_REQUIRES = {"idrive7-renderd": "2.1.7", "mgu-inputgate": "1.0.0"}
# These global tool IDs belong to cauliflowermossgrape/idrive7-apps, which is
# a default MGU Store source. Publishing private forks under the same IDs makes
# the updater correctly reject a cross-source takeover of an installed tool.
EXTERNAL_COMPONENTS = {"idrive7-renderd", "mgu-inputgate"}
# The MGU's LTE path occasionally times out while following github.com release
# redirects. This tiny always-on tool is also committed under packages/, so use
# GitHub's direct raw-content host and keep the catalog SHA-256 verification.
RAW_ARTIFACTS = {"remote-telemetry-bridge"}
SPECIAL_REQUIRES = {
    "drive_hud_full": {"cluster-render": "0.3.10"},
    "front_camera_cluster": {"front-camera-cluster-helper": "0.2.1"},
    "hotspot_studio": {"hotspot-studio-helper": "0.1.1"},
    "vehicle_network": {"vehicle-network-observer": "0.1.2"},
    "waze_hud": {"waze-hud-control": "0.3.0"},
}


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def read_package(path: str) -> dict:
    with tarfile.open(path, "r:gz") as tf:
        names = set(tf.getnames())
        if "package/package.json" in names:
            data = json.load(tf.extractfile("package/package.json"))
            data["kind"] = "app"
            data["id"] = data["name"]
            return data
        if "component.json" in names:
            return json.load(tf.extractfile("component.json"))
    raise ValueError(f"No app or component manifest in {path}")


def next_tag() -> str:
    requested = os.environ.get("INPUT_TAG", "").strip()
    if requested:
        return requested
    try:
        tags = subprocess.check_output(["git", "tag", "-l", "v*"], cwd=ROOT, text=True).split()
    except Exception:
        tags = []
    versions = []
    for tag in tags:
        match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", tag)
        if match:
            versions.append(tuple(map(int, match.groups())))
    if not versions:
        return "v1.0.0"
    major, minor, patch = max(versions)
    return f"v{major}.{minor}.{patch + 1}"


def version_key(value: str) -> tuple:
    """Order the simple semantic versions used by MGU packages."""
    main, separator, prerelease = value.partition("-")
    numbers = tuple(int(part) if part.isdigit() else 0 for part in main.split("."))
    return numbers, 1 if not separator else 0, prerelease


def main() -> None:
    package_paths = sorted(glob.glob(os.path.join(PACKAGES, "*.tgz")))
    if not package_paths:
        raise SystemExit("No .tgz packages found in packages/")

    # Old package releases stay in packages/ so their GitHub assets remain
    # reproducible. The Store catalog must contain exactly one entry per ID.
    latest = {}
    for path in package_paths:
        manifest = read_package(path)
        component_id = manifest["id"]
        if component_id in EXTERNAL_COMPONENTS:
            continue
        current = latest.get(component_id)
        if current is None or version_key(manifest["version"]) > version_key(current[1]["version"]):
            latest[component_id] = (path, manifest)
    selected = sorted(latest.values(), key=lambda item: item[1]["id"])

    components = []
    apps_meta = {}
    app_notes = []
    tool_notes = []

    for path, manifest in selected:
        component_id = manifest["id"]
        kind = manifest.get("kind", "app")
        app_source = os.path.join(ROOT, "apps", component_id, "app.json")
        source_manifest = {}
        if kind == "app" and os.path.isfile(app_source):
            with open(app_source, encoding="utf-8") as stream:
                source_manifest = json.load(stream)
            if source_manifest.get("version") != manifest.get("version"):
                raise ValueError(f"Version mismatch for {component_id}")
        title = source_manifest.get("title") or manifest.get("productName") or manifest.get("title") or component_id
        description = source_manifest.get("description") or manifest.get("description", "")
        requires = dict(manifest.get("requires") or {})
        if kind == "app":
            requires = {**APP_REQUIRES, **SPECIAL_REQUIRES.get(component_id, {}), **requires}
        filename = os.path.basename(path)
        release_tag = f"{component_id}@{manifest['version']}"
        if component_id in RAW_ARTIFACTS:
            artifact_url = "https://raw.githubusercontent.com/{}/main/packages/{}".format(
                REPOSITORY, urllib.parse.quote(filename, safe="@")
            )
        else:
            artifact_url = "https://github.com/{}/releases/download/{}/{}".format(
                REPOSITORY,
                urllib.parse.quote(release_tag, safe="@"),
                urllib.parse.quote(filename, safe="@"),
            )
        artifact = {
            "name": filename,
            "size": os.path.getsize(path),
            "sha256": sha256(path),
            "url": artifact_url,
        }
        item = {
            "id": component_id,
            "kind": kind,
            "version": manifest["version"],
            "title": title,
            "description": description,
            "mguHmi": manifest.get("mguHmi") or ["ID7"],
            "artifact": artifact,
            "uninstallable": manifest.get("uninstallable", True),
        }
        if requires:
            item["requires"] = requires
        if manifest.get("mguProvides"):
            item["mguProvides"] = manifest["mguProvides"]
        components.append(item)

        note = f"* **{title}** `{manifest['version']}` — {description}"
        if kind == "app":
            icon_name = f"{component_id}.png"
            icon_path = os.path.join(ROOT, icon_name)
            meta = {
                "title": title,
                "description": description,
                "author": source_manifest.get("vendor") or manifest.get("author", "alexp50"),
            }
            if os.path.isfile(icon_path):
                meta.update({"icon": icon_name, "iconSha256": sha256(icon_path)})
            apps_meta[component_id] = meta
            item["author"] = meta["author"]
            if "icon" in meta:
                item["icon"] = meta["icon"]
                item["iconSha256"] = meta["iconSha256"]
            app_notes.append(note)
        else:
            tool_notes.append(note)

    components.sort(key=lambda item: (item["kind"] != "app", item["title"].lower()))
    with open(os.path.join(ROOT, "catalog.json"), "w", encoding="utf-8") as stream:
        json.dump({"schema": 2, "name": "AlexP50 BMW Apps", "components": components}, stream, indent=2)
        stream.write("\n")
    with open(os.path.join(ROOT, "mgu-store.json"), "w", encoding="utf-8") as stream:
        json.dump({"apps": apps_meta}, stream, indent=2)
        stream.write("\n")

    notes = ["# AlexP50 BMW iDrive 7 apps", "", "## Applications", *app_notes, "", "## Required tools", *tool_notes, ""]
    with open(os.path.join(ROOT, "release_notes.md"), "w", encoding="utf-8") as stream:
        stream.write("\n".join(notes))

    tag = next_tag()
    print(f"Prepared {len(app_notes)} apps and {len(tool_notes)} tools as {tag}")
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as stream:
            stream.write(f"tag={tag}\n")
            stream.write(f"title=AlexP50 BMW Apps {tag}\n")


if __name__ == "__main__":
    main()
