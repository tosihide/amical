"""Reconcile Electron's tracked key state with OS truth."""

from ..evdev.monitor import get_pressed_keys


def handle_recheck_pressed_keys(params: dict) -> dict:
    pressed_key_codes = params.get("pressedKeyCodes", [])
    actually_pressed = get_pressed_keys()

    stale = [code for code in pressed_key_codes if code not in actually_pressed]
    return {"staleKeyCodes": stale}
