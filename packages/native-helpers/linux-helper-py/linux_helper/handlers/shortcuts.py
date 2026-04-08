"""Shortcut configuration storage."""

import threading

_lock = threading.Lock()
_shortcuts = {
    "pushToTalk": [],
    "toggleRecording": [],
    "pasteLastTranscript": [],
    "newNote": [],
}


def get_shortcuts() -> dict:
    with _lock:
        return _shortcuts.copy()


def handle_set_shortcuts(params: dict) -> dict:
    global _shortcuts
    with _lock:
        _shortcuts = {
            "pushToTalk": params.get("pushToTalk", []),
            "toggleRecording": params.get("toggleRecording", []),
            "pasteLastTranscript": params.get("pasteLastTranscript", []),
            "newNote": params.get("newNote", []),
        }
    return {"success": True}
