#!/usr/bin/env python3
"""Install the workspace extension locally, with a backup and rollback on failure."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def manifest(directory):
    return {
        str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in directory.rglob("*")
        if path.is_file() and path.name != "gschemas.compiled"
    }


def install():
    repo = Path(__file__).resolve().parent.parent
    source = repo / "bezel@deluca21"
    uuid = json.loads((source / "metadata.json").read_text())["uuid"]
    if uuid != source.name:
        raise RuntimeError("Extension UUID does not match the source directory")
    data_home = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share")
    extensions = data_home / "gnome-shell/extensions"
    extensions.mkdir(parents=True, exist_ok=True)
    destination = extensions / uuid
    if destination.is_symlink():
        raise RuntimeError(f"Local installation is a symlink; preserve its target: {destination}")

    expected = manifest(source)
    with tempfile.TemporaryDirectory(prefix=".bezel-install-", dir=extensions) as temporary:
        temporary = Path(temporary)
        staged = temporary / uuid
        shutil.copytree(source, staged, ignore=shutil.ignore_patterns("gschemas.compiled"))
        subprocess.run(["glib-compile-schemas", "--strict", str(staged / "schemas")], check=True)
        if manifest(staged) != expected:
            raise RuntimeError("Source changed during installation; rerun the installer")
        compiled = (staged / "schemas/gschemas.compiled").read_bytes()

        backup = None
        if destination.exists():
            backups = repo / ".backups"
            backups.mkdir(exist_ok=True)
            backup = Path(tempfile.mkdtemp(prefix="local-install-", dir=backups)) / uuid
            shutil.copytree(destination, backup)

        previous = temporary / "previous"
        if destination.exists():
            destination.rename(previous)
        try:
            staged.rename(destination)
            if manifest(destination) != expected:
                raise RuntimeError("Installed files do not match the workspace")
            if (destination / "schemas/gschemas.compiled").read_bytes() != compiled:
                raise RuntimeError("Installed schemas do not match the compiled schemas")
        except BaseException:
            if destination.exists():
                shutil.rmtree(destination)
            if previous.exists():
                previous.rename(destination)
            raise

    print(f"Installed and verified {len(expected)} files: {destination}")
    if backup:
        print(f"Previous installation: {backup}")
    print("On Wayland, log out and back in to load updated extension JavaScript.")


if __name__ == "__main__":
    install()
