"""Accessibility context via GNOME Shell D-Bus."""

import json
import os
import subprocess
import sys
import time


def _get_gnome_active_window() -> dict:
    default = {"appName": None, "windowTitle": None, "pid": 0}

    try:
        script = """
(function() {
  let w = global.display.get_focus_window();
  if (!w) return JSON.stringify({title: null, wmClass: null, pid: 0});
  return JSON.stringify({
    title: w.get_title(),
    wmClass: w.get_wm_class(),
    pid: w.get_pid()
  });
})()
""".strip()

        result = subprocess.run(
            [
                "gdbus", "call", "--session",
                "--dest", "org.gnome.Shell",
                "--object-path", "/org/gnome/Shell",
                "--method", "org.gnome.Shell.Eval",
                script,
            ],
            capture_output=True, text=True, timeout=3,
        )

        # Parse gdbus output: (true, '{"title":"...","wmClass":"...","pid":123}')
        stdout = result.stdout.strip()
        if "(true," not in stdout:
            return default

        # Extract JSON string between single quotes
        start = stdout.index("'") + 1
        end = stdout.rindex("'")
        parsed = json.loads(stdout[start:end])

        return {
            "appName": parsed.get("wmClass"),
            "windowTitle": parsed.get("title"),
            "pid": parsed.get("pid", 0),
        }
    except Exception:
        return default


def handle_get_accessibility_context(params: dict) -> dict:
    info = _get_gnome_active_window()

    if not info["appName"] and not info["windowTitle"]:
        return {"context": None}

    return {
        "context": {
            "schemaVersion": "2.0",
            "application": {
                "name": info["appName"],
                "bundleIdentifier": None,
                "version": None,
                "pid": info["pid"],
            },
            "windowInfo": {
                "title": info["windowTitle"],
                "url": None,
            },
            "focusedElement": None,
            "textSelection": None,
            "timestamp": int(time.time()),
            "metrics": {
                "totalTimeMs": 0,
                "textMarkerAttempted": False,
                "textMarkerSucceeded": False,
                "fallbacksUsed": [],
                "errors": [],
                "timedOut": False,
                "webAreaRetryAttempted": False,
                "webAreaFound": False,
                "webAreaRetrySucceeded": False,
            },
        }
    }


def _check_command(cmd: str) -> bool:
    try:
        subprocess.run(["which", cmd], capture_output=True, check=True)
        return True
    except (subprocess.SubprocessError, OSError):
        return False


def _check_evdev_access() -> bool:
    try:
        for entry in os.listdir("/dev/input"):
            if entry.startswith("event"):
                if os.access(f"/dev/input/{entry}", os.R_OK):
                    return True
    except OSError:
        pass
    return False


def handle_get_accessibility_status(params: dict) -> dict:
    all_ok = all([
        _check_command("wl-copy"),
        _check_command("ydotool"),
        _check_command("pactl"),
        _check_evdev_access(),
    ])
    return {"hasPermission": all_ok, "isEnabled": True}


def handle_request_accessibility_permission(params: dict) -> dict:
    status = handle_get_accessibility_status({})
    return {"granted": status["hasPermission"]}


def handle_get_accessibility_tree_details(params: dict) -> dict:
    return {"tree": None}
