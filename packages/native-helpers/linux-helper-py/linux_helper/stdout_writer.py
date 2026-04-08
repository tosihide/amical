"""Thread-safe stdout writer for JSON-RPC responses and events."""

import json
import sys
import threading
from typing import Any

_lock = threading.Lock()


def write_line(obj: Any) -> None:
    line = json.dumps(obj, ensure_ascii=False)
    with _lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def write_response(request_id: str, result: Any) -> None:
    write_line({"id": request_id, "result": result})


def write_error(request_id: str, code: int, message: str, data: Any = None) -> None:
    error = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    write_line({"id": request_id, "error": error})


def write_event(event: dict) -> None:
    write_line(event)
