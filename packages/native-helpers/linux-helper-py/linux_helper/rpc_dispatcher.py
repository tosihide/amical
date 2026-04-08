"""RPC request dispatcher."""

import traceback
import sys

from .stdout_writer import write_response, write_error
from .handlers.paste_text import handle_paste_text
from .handlers.recording import handle_start_recording, handle_stop_recording
from .handlers.shortcuts import handle_set_shortcuts
from .handlers.recheck_pressed_keys import handle_recheck_pressed_keys
from .handlers.accessibility import (
    handle_get_accessibility_context,
    handle_get_accessibility_status,
    handle_request_accessibility_permission,
    handle_get_accessibility_tree_details,
)

HANDLERS = {
    "pasteText": handle_paste_text,
    "startRecording": handle_start_recording,
    "stopRecording": handle_stop_recording,
    "setShortcuts": handle_set_shortcuts,
    "recheckPressedKeys": handle_recheck_pressed_keys,
    "getAccessibilityContext": handle_get_accessibility_context,
    "getAccessibilityStatus": handle_get_accessibility_status,
    "requestAccessibilityPermission": handle_request_accessibility_permission,
    "getAccessibilityTreeDetails": handle_get_accessibility_tree_details,
}


def dispatch(request: dict) -> None:
    request_id = request.get("id")
    method = request.get("method")
    params = request.get("params", {})

    handler = HANDLERS.get(method)
    if handler is None:
        write_error(request_id, -32601, f"Method not found: {method}")
        return

    try:
        result = handler(params)
        write_response(request_id, result)
    except Exception as e:
        sys.stderr.write(f"LinuxHelper: handler error: {traceback.format_exc()}\n")
        write_error(request_id, -32603, str(e))
