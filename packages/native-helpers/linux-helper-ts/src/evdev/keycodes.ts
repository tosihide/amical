/** Linux evdev key codes for common keys */

// Modifiers
export const KEY_LEFTCTRL = 29;
export const KEY_LEFTSHIFT = 42;
export const KEY_RIGHTSHIFT = 54;
export const KEY_LEFTALT = 56;
export const KEY_RIGHTALT = 100;
export const KEY_LEFTMETA = 125;
export const KEY_RIGHTMETA = 126;
export const KEY_FN = 464;

// Common keys
export const KEY_V = 47;
export const KEY_C = 46;

const MODIFIER_KEYCODES = new Set([
  KEY_LEFTCTRL,
  KEY_LEFTSHIFT,
  KEY_RIGHTSHIFT,
  KEY_LEFTALT,
  KEY_RIGHTALT,
  KEY_LEFTMETA,
  KEY_RIGHTMETA,
  KEY_FN,
]);

export function isModifierKeyCode(code: number): boolean {
  return MODIFIER_KEYCODES.has(code);
}

export function getModifierFlags(pressedKeys: Set<number>): {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
} {
  return {
    ctrlKey: pressedKeys.has(KEY_LEFTCTRL) || pressedKeys.has(29 + 97), // KEY_RIGHTCTRL=97
    shiftKey: pressedKeys.has(KEY_LEFTSHIFT) || pressedKeys.has(KEY_RIGHTSHIFT),
    altKey: pressedKeys.has(KEY_LEFTALT) || pressedKeys.has(KEY_RIGHTALT),
    metaKey: pressedKeys.has(KEY_LEFTMETA) || pressedKeys.has(KEY_RIGHTMETA),
  };
}
