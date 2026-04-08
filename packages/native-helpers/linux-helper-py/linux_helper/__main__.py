"""Linux native helper for Amical - entry point."""

import json
import sys

from .rpc_dispatcher import dispatch
from .evdev.monitor import start_keyboard_monitor


def main() -> None:
    sys.stderr.write("LinuxHelperPy: starting\n")

    # Start keyboard monitoring in background threads
    start_keyboard_monitor()

    # Read JSON-RPC requests from stdin (one JSON object per line)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            sys.stderr.write(f"LinuxHelperPy: JSON parse error: {e}\n")
            continue

        if "id" not in request or "method" not in request:
            sys.stderr.write("LinuxHelperPy: invalid request (missing id or method)\n")
            continue

        dispatch(request)

    sys.stderr.write("LinuxHelperPy: stdin closed, exiting\n")


if __name__ == "__main__":
    main()
