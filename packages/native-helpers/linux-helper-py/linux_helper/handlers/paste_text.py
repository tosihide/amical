"""Paste text into the active application via wl-copy + ydotool."""

import subprocess
import time


def handle_paste_text(params: dict) -> dict:
    transcript = params.get("transcript", "")
    preserve_clipboard = params.get("preserveClipboard", True)

    if not transcript:
        return {"success": False, "message": "No transcript provided"}

    saved_clipboard = None

    try:
        # Save current clipboard
        if preserve_clipboard:
            try:
                result = subprocess.run(
                    ["wl-paste", "--no-newline"],
                    capture_output=True, text=True, timeout=5,
                )
                saved_clipboard = result.stdout
            except (subprocess.SubprocessError, OSError):
                saved_clipboard = ""

        # Set clipboard to transcript
        subprocess.run(
            ["wl-copy", "--", transcript],
            check=True, timeout=5,
        )

        # Small delay to ensure clipboard is set
        time.sleep(0.05)

        # Simulate Ctrl+V via ydotool
        # keycode 29 = KEY_LEFTCTRL, 47 = KEY_V
        subprocess.run(
            ["ydotool", "key", "29:1", "47:1", "47:0", "29:0"],
            check=True, timeout=5,
        )

        # Restore clipboard after delay
        if preserve_clipboard and saved_clipboard is not None:
            def _restore():
                time.sleep(0.5)
                try:
                    subprocess.run(
                        ["wl-copy", "--", saved_clipboard],
                        timeout=5,
                    )
                except (subprocess.SubprocessError, OSError):
                    pass

            import threading
            threading.Thread(target=_restore, daemon=True).start()

        return {"success": True}

    except Exception as e:
        return {"success": False, "message": str(e)}
