"""Linux evdev key code constants."""

# Modifiers
KEY_LEFTCTRL = 29
KEY_LEFTSHIFT = 42
KEY_RIGHTSHIFT = 54
KEY_LEFTALT = 56
KEY_RIGHTALT = 100
KEY_LEFTMETA = 125
KEY_RIGHTMETA = 126
KEY_RIGHTCTRL = 97
KEY_FN = 464

# Common keys
KEY_V = 47
KEY_C = 46

MODIFIER_KEYCODES = frozenset({
    KEY_LEFTCTRL, KEY_RIGHTCTRL,
    KEY_LEFTSHIFT, KEY_RIGHTSHIFT,
    KEY_LEFTALT, KEY_RIGHTALT,
    KEY_LEFTMETA, KEY_RIGHTMETA,
    KEY_FN,
})


def is_modifier(code: int) -> bool:
    return code in MODIFIER_KEYCODES


def get_modifier_flags(pressed: set[int]) -> dict:
    return {
        "ctrlKey": KEY_LEFTCTRL in pressed or KEY_RIGHTCTRL in pressed,
        "shiftKey": KEY_LEFTSHIFT in pressed or KEY_RIGHTSHIFT in pressed,
        "altKey": KEY_LEFTALT in pressed or KEY_RIGHTALT in pressed,
        "metaKey": KEY_LEFTMETA in pressed or KEY_RIGHTMETA in pressed,
    }
