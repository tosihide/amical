"""Keyboard event monitoring via Linux evdev."""

import os
import struct
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

from ..stdout_writer import write_event
from .keycodes import is_modifier, get_modifier_flags, KEY_FN

# Linux input event constants
EV_KEY = 1
# struct input_event on 64-bit:
# uint64 sec, uint64 usec, uint16 type, uint16 code, int32 value
INPUT_EVENT_FORMAT = "QQHHi"
INPUT_EVENT_SIZE = struct.calcsize(INPUT_EVENT_FORMAT)

# Track pressed keys globally
pressed_keys: set[int] = set()
_lock = threading.Lock()


def get_pressed_keys() -> set[int]:
    with _lock:
        return pressed_keys.copy()


def _scan_keyboard_devices() -> list[str]:
    """Find keyboard devices by checking their key capabilities."""
    devices = []
    input_dir = Path("/dev/input")

    try:
        for entry in sorted(input_dir.iterdir()):
            if not entry.name.startswith("event"):
                continue

            caps_path = Path(f"/sys/class/input/{entry.name}/device/capabilities/key")
            try:
                caps = caps_path.read_text().strip()
                if not caps or caps == "0":
                    continue

                # Count set bits - real keyboards have many key capabilities
                total_bits = sum(
                    bin(int(part, 16)).count("1") for part in caps.split()
                )
                if total_bits > 20:
                    devices.append(str(entry))
            except (OSError, ValueError):
                continue
    except OSError as e:
        sys.stderr.write(f"Failed to scan input devices: {e}\n")

    return devices


def _emit_key_event(event_type: str, key_code: int) -> None:
    flags = get_modifier_flags(pressed_keys)
    event = {
        "type": event_type,
        "payload": {
            "keyCode": key_code,
            "key": None,
            "code": None,
            "altKey": flags["altKey"],
            "ctrlKey": flags["ctrlKey"],
            "shiftKey": flags["shiftKey"],
            "metaKey": flags["metaKey"],
            "fnKeyPressed": KEY_FN in pressed_keys,
        },
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    write_event(event)


def _monitor_device(device_path: str) -> None:
    """Monitor a single evdev device for key events."""
    while True:
        try:
            fd = os.open(device_path, os.O_RDONLY)
        except OSError as e:
            sys.stderr.write(f"Cannot open {device_path}: {e}\n")
            return

        try:
            while True:
                data = os.read(fd, INPUT_EVENT_SIZE * 64)
                if not data:
                    break

                offset = 0
                while offset + INPUT_EVENT_SIZE <= len(data):
                    _sec, _usec, ev_type, code, value = struct.unpack_from(
                        INPUT_EVENT_FORMAT, data, offset
                    )
                    offset += INPUT_EVENT_SIZE

                    if ev_type != EV_KEY:
                        continue

                    with _lock:
                        if value == 1:  # Key down
                            pressed_keys.add(code)
                            if is_modifier(code):
                                _emit_key_event("flagsChanged", code)
                            else:
                                _emit_key_event("keyDown", code)
                        elif value == 0:  # Key up
                            pressed_keys.discard(code)
                            if is_modifier(code):
                                _emit_key_event("flagsChanged", code)
                            else:
                                _emit_key_event("keyUp", code)
                        elif value == 2:  # Key repeat
                            _emit_key_event("keyDown", code)
        except OSError as e:
            sys.stderr.write(f"Error reading {device_path}: {e}\n")
        finally:
            os.close(fd)

        import time
        sys.stderr.write(f"Device {device_path} closed, retrying in 5s\n")
        time.sleep(5)


def start_keyboard_monitor() -> None:
    """Start monitoring all keyboard devices in background threads."""
    devices = _scan_keyboard_devices()
    if not devices:
        sys.stderr.write(
            "No keyboard devices found. Ensure user is in 'input' group.\n"
        )
        return

    sys.stderr.write(f"Monitoring keyboard devices: {', '.join(devices)}\n")
    for device in devices:
        t = threading.Thread(target=_monitor_device, args=(device,), daemon=True)
        t.start()
