"""Paste text into the active application via wl-copy + ydotool."""

import subprocess
import time


def _run_wl_copy(text: str) -> None:
    """Run wl-copy detached.

    wl-copy forks and stays resident to serve clipboard paste requests,
    so we must start it without waiting for it to exit.
    """
    proc = subprocess.Popen(
        ["wl-copy", "--", text],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    # Give it a moment to register with the compositor
    time.sleep(0.1)
    # Don't wait — the process stays alive to serve pastes


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

        # Set clipboard to transcript (detached — wl-copy stays resident)
        _run_wl_copy(transcript)

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
                    _run_wl_copy(saved_clipboard)
                except OSError:
                    pass

            import threading
            threading.Thread(target=_restore, daemon=True).start()

        return {"success": True}

    except Exception as e:
        return {"success": False, "message": str(e)}
