#!/usr/bin/env python3
"""Exercise motion in a private two-monitor GNOME Shell, leaving the desktop alone."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--calendar-only', action='store_true', help='Only check calendar text alignment')
parser.add_argument('--session-only', action='store_true', help='Only check lock/unlock session animations')
parser.add_argument('--overflow-only', action='store_true', help='Only check scroll decoration alignment')
parser.add_argument('--text-only', action='store_true', help='Only check text container pixel alignment')
parser.add_argument('--startup-only', action='store_true', help='Only check late-loading bar icons')
args = parser.parse_args()
repo = Path(__file__).resolve().parent.parent
root = Path(tempfile.mkdtemp(prefix="bezel-motion-shell-"))
(root / "runtime").mkdir(mode=0o700)
(root / "config").mkdir()
(root / "screenshots").mkdir()
mode = root / "system-data/gnome-shell/modes"
mode.mkdir(parents=True)
(mode / "bezel-test.json").write_text(json.dumps({
    "parentMode": "user", "enabledExtensions": ["bezel@deluca21"],
    "components": [], "showWelcomeDialog": False,
}))
extension = root / "bezel@deluca21"
shutil.copytree(repo / "bezel@deluca21", extension)
shutil.copytree(repo / "tests", root / "tests")
installed = root / "data/gnome-shell/extensions"
installed.mkdir(parents=True)
(installed / "bezel@deluca21").symlink_to(extension, target_is_directory=True)
subprocess.run(["glib-compile-schemas", "--strict", str(extension / "schemas")], check=True)
entry = extension / "extension.js"
source = entry.read_text().replace("import GObject from", "import GLib from 'gi://GLib';\nimport GObject from", 1)
# Only the disposable copy gains a startup test hook.
hook = """
            if (!this._integrationStarted) {
            this._integrationStarted = true;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
                const run = async () => {
                    const capture = async theme => {
                        const stream = Gio.File.new_for_path(SCREEN_DIR + '/' + theme + '.png')
                            .replace(null, false, Gio.FileCreateFlags.NONE, null);
                        try { await new Shell.Screenshot().screenshot(false, stream); }
                        finally { stream.close(null); }
                    };
                    const textRendering = await import(TEXT_URI);
                    if (TEXT_ONLY) return {textLayouts: await textRendering.run(this._overlay, capture)};
                    const overflow = await import(OVERFLOW_URI);
                    if (OVERFLOW_ONLY) return {overflowLayouts: await overflow.run(this._overlay, capture)};
                    const startup = await import(STARTUP_URI);
                    if (STARTUP_ONLY) return {startupLayouts: await startup.run(this._overlay)};
                    const sessions = await import(SESSION_URI);
                    if (SESSION_ONLY) return {sessionAnimations: await sessions.run(this)};
                    const calendar = await import(CALENDAR_URI);
                    const calendarLayouts = await calendar.run(this._overlay, capture);
                    if (CALENDAR_ONLY) return {calendarLayouts};
                    const motion = await import(MOTION_URI);
                    const results = {...await motion.run(this._overlay, capture), calendarLayouts,
                        overflowLayouts: await overflow.run(this._overlay, capture)};
                    console.log('BEZEL_MOTION_INTEGRATION_PASS ' + JSON.stringify(results));
                    const picking = await import(PICKING_URI);
                    results.sidebarPicking = (await picking.run(this._overlay)).length;
                    results.textLayouts = await textRendering.run(this._overlay, capture);
                    results.startupLayouts = await startup.run(this._overlay);
                    results.sessionAnimations = await sessions.run(this);
                    return results;
                };
                const finish = result => Gio.File.new_for_path(RESULT_PATH).replace_contents(
                    JSON.stringify(result), null, false, Gio.FileCreateFlags.NONE, null);
                run().then(result => finish({ok: true, ...result}))
                    .catch(error => { console.error(error); finish({ok: false, error: String(error), stack: error.stack}); });
                return GLib.SOURCE_REMOVE;
            });
            }
"""
for key, value in {
    "TEXT_URI": (root / "tests/text-rendering.js").as_uri(),
    "TEXT_ONLY": args.text_only,
    "OVERFLOW_URI": (root / "tests/overflow-layout.js").as_uri(),
    "OVERFLOW_ONLY": args.overflow_only,
    "STARTUP_URI": (root / "tests/startup-layout.js").as_uri(),
    "STARTUP_ONLY": args.startup_only,
    "SESSION_URI": (root / "tests/session-integration.js").as_uri(),
    "SESSION_ONLY": args.session_only,
    "CALENDAR_URI": (root / "tests/calendar-layout.js").as_uri(),
    "CALENDAR_ONLY": args.calendar_only,
    "MOTION_URI": (root / "tests/motion-integration.js").as_uri(),
    "PICKING_URI": (root / "tests/sidebar-hit-testing.js").as_uri(),
    "SCREEN_DIR": str(root / "screenshots"),
    "RESULT_PATH": str(root / "result.json"),
}.items():
    hook = hook.replace(key, json.dumps(value))
source = source.replace("            this._syncOverviewDash();", "            this._syncOverviewDash();" + hook, 1)
entry.write_text(source)
env = os.environ.copy()
env.update({
    "XDG_RUNTIME_DIR": str(root / "runtime"), "XDG_DATA_HOME": str(root / "data"),
    "XDG_CONFIG_HOME": str(root / "config"), "XDG_CACHE_HOME": str(root / "cache"),
    "XDG_DATA_DIRS": f"{root}/system-data:/usr/local/share:/usr/share", "GSETTINGS_BACKEND": "memory",
})
for key in ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"]:
    env.pop(key, None)
print(f"Isolated Shell logs and screenshots: {root}", flush=True)
with (root / "shell.log").open("w") as log:
    process = subprocess.Popen([
        "dbus-run-session", "--", "gnome-shell", "--headless", "--wayland", "--no-x11",
        "--virtual-monitor", "1280x800", "--virtual-monitor", "800x1280", "--mode=bezel-test",
    ], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        deadline = time.monotonic() + 240
        while not (root / "result.json").exists():
            if process.poll() is not None:
                raise RuntimeError(f"Isolated Shell exited early; inspect {root}/shell.log")
            if time.monotonic() > deadline:
                raise TimeoutError(f"Isolated Shell timed out; inspect {root}/shell.log")
            time.sleep(.5)
        result = json.loads((root / "result.json").read_text())
        # GJS can log invalid native-object access without rejecting the JS
        # promise. Treat extension stack traces as failures as well.
        runtime_errors = [match.group(0) for match in re.finditer(
            r"(?:Gjs-CRITICAL|JS ERROR)[^\n]*(?:\n[^\n]+)*", (root / "shell.log").read_text())
            if "bezel@deluca21/" in match.group(0)]
        if runtime_errors:
            result.update(ok=False, runtimeErrors=len(runtime_errors),
                          error=f"Extension runtime errors; inspect {root}/shell.log")
        print(json.dumps(result, indent=2))
        if not result["ok"]:
            raise SystemExit(1)
    finally:
        # This process group belongs only to the private test session.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
