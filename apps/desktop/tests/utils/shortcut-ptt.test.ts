import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { LINUX_KEYCODES } from "../../src/utils/keycodes";

/**
 * Test the ShortcutManager PTT (push-to-talk) and toggle-recording detection logic.
 *
 * ShortcutManager relies on NativeBridge for key events, so we mock NativeBridge
 * and SettingsService, then simulate key presses via helperEvent emissions.
 */

// Mock modules before importing ShortcutManager
vi.mock("electron", async () => {
  const { createElectronMocks } = await import("../helpers/electron-mocks");
  return createElectronMocks();
});

vi.mock("@/main/logger", () => ({
  logger: {
    main: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    audio: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock("@/utils/keycode-map", () => ({
  getKeyFromKeycode: (code: number) => {
    // Return a truthy value for known keycodes so isKnownKeycode passes
    const known: Record<number, string> = {
      [LINUX_KEYCODES.CTRL]: "Ctrl",
      [LINUX_KEYCODES.META]: "Meta",
      [LINUX_KEYCODES.SPACE]: "Space",
      [LINUX_KEYCODES.SHIFT]: "Shift",
      [LINUX_KEYCODES.ALT]: "Alt",
      [LINUX_KEYCODES.V]: "V",
      [LINUX_KEYCODES.N]: "N",
    };
    return known[code];
  },
}));

vi.mock("@/utils/shortcut-validation", () => ({
  validateShortcutComprehensive: vi.fn(() => ({ valid: true })),
}));

// Create mock NativeBridge as EventEmitter
function createMockNativeBridge() {
  const bridge = new EventEmitter();
  (bridge as any).setShortcuts = vi.fn().mockResolvedValue(true);
  (bridge as any).recheckPressedKeys = vi
    .fn()
    .mockResolvedValue({ staleKeyCodes: [] });
  return bridge;
}

function createMockSettingsService(shortcuts: Record<string, number[]>) {
  return {
    getShortcuts: vi.fn().mockResolvedValue(shortcuts),
    setShortcuts: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeKeyPayload(keyCode: number) {
  return {
    keyCode,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
    fnKeyPressed: false,
  };
}

describe("ShortcutManager - PTT and Toggle Recording", () => {
  let ShortcutManager: any;
  let nativeBridge: EventEmitter;
  let settingsService: any;
  let manager: any;

  const SHORTCUTS = {
    pushToTalk: [LINUX_KEYCODES.CTRL, LINUX_KEYCODES.META],
    toggleRecording: [
      LINUX_KEYCODES.CTRL,
      LINUX_KEYCODES.META,
      LINUX_KEYCODES.SPACE,
    ],
    pasteLastTranscript: [
      LINUX_KEYCODES.ALT,
      LINUX_KEYCODES.SHIFT,
      LINUX_KEYCODES.V,
    ],
    newNote: [LINUX_KEYCODES.ALT, LINUX_KEYCODES.SHIFT, LINUX_KEYCODES.N],
  };

  beforeEach(async () => {
    vi.resetModules();
    // Re-import after mock reset
    const mod = await import("../../src/main/managers/shortcut-manager");
    ShortcutManager = mod.ShortcutManager;

    nativeBridge = createMockNativeBridge();
    settingsService = createMockSettingsService(SHORTCUTS);
    manager = new ShortcutManager(settingsService, nativeBridge);
    await manager.initialize();
  });

  function pressKey(keyCode: number) {
    nativeBridge.emit("helperEvent", {
      type: "flagsChanged",
      payload: makeKeyPayload(keyCode),
    });
  }

  function releaseKey(keyCode: number) {
    // For modifiers tracked as flagsChanged, a second flagsChanged toggles
    // (the ShortcutManager checks if key is already in activeKeys)
    nativeBridge.emit("helperEvent", {
      type: "flagsChanged",
      payload: makeKeyPayload(keyCode),
    });
  }

  function pressNonModifier(keyCode: number) {
    nativeBridge.emit("helperEvent", {
      type: "keyDown",
      payload: makeKeyPayload(keyCode),
    });
  }

  function releaseNonModifier(keyCode: number) {
    nativeBridge.emit("helperEvent", {
      type: "keyUp",
      payload: makeKeyPayload(keyCode),
    });
  }

  describe("Push-to-Talk (Ctrl+Meta)", () => {
    it("should emit ptt-state-changed=true when Ctrl+Meta pressed", () => {
      const states: boolean[] = [];
      manager.on("ptt-state-changed", (pressed: boolean) =>
        states.push(pressed),
      );

      pressKey(LINUX_KEYCODES.CTRL);
      pressKey(LINUX_KEYCODES.META);

      // PTT uses subset match, so at least one emission should be true
      expect(states).toContain(true);
    });

    it("should emit ptt-state-changed=false when keys released", () => {
      const states: boolean[] = [];
      manager.on("ptt-state-changed", (pressed: boolean) =>
        states.push(pressed),
      );

      // Press
      pressKey(LINUX_KEYCODES.CTRL);
      pressKey(LINUX_KEYCODES.META);

      // Release
      releaseKey(LINUX_KEYCODES.META);

      // Last state should be false (PTT requires both keys)
      expect(states[states.length - 1]).toBe(false);
    });

    it("should keep PTT active while both keys held", () => {
      const states: boolean[] = [];
      manager.on("ptt-state-changed", (pressed: boolean) =>
        states.push(pressed),
      );

      pressKey(LINUX_KEYCODES.CTRL);
      pressKey(LINUX_KEYCODES.META);

      // Both pressed — last state should be true
      const trueStates = states.filter((s) => s === true);
      expect(trueStates.length).toBeGreaterThan(0);
    });

    it("should not trigger PTT with only Ctrl pressed", () => {
      const states: boolean[] = [];
      manager.on("ptt-state-changed", (pressed: boolean) =>
        states.push(pressed),
      );

      pressKey(LINUX_KEYCODES.CTRL);

      // Single modifier should not activate PTT
      expect(states).not.toContain(true);
    });
  });

  describe("Toggle Recording / Hands-free (Ctrl+Meta+Space)", () => {
    it("should emit toggle-recording-triggered on exact Ctrl+Meta+Space", () => {
      let triggered = false;
      manager.on("toggle-recording-triggered", () => {
        triggered = true;
      });

      pressKey(LINUX_KEYCODES.CTRL);
      pressKey(LINUX_KEYCODES.META);
      pressNonModifier(LINUX_KEYCODES.SPACE);

      expect(triggered).toBe(true);
    });

    it("should not emit toggle-recording-triggered with extra keys", () => {
      let triggered = false;
      manager.on("toggle-recording-triggered", () => {
        triggered = true;
      });

      pressKey(LINUX_KEYCODES.CTRL);
      pressKey(LINUX_KEYCODES.META);
      pressKey(LINUX_KEYCODES.SHIFT);
      pressNonModifier(LINUX_KEYCODES.SPACE);

      // Extra Shift key means not an exact match
      expect(triggered).toBe(false);
    });

    it("should not trigger toggle with only Ctrl+Meta (no Space)", () => {
      let triggered = false;
      manager.on("toggle-recording-triggered", () => {
        triggered = true;
      });

      pressKey(LINUX_KEYCODES.CTRL);
      pressKey(LINUX_KEYCODES.META);

      expect(triggered).toBe(false);
    });
  });

  describe("PTT vs Toggle distinction", () => {
    it("Ctrl+Meta activates PTT but not toggle", () => {
      let pttActive = false;
      let toggleTriggered = false;
      manager.on("ptt-state-changed", (pressed: boolean) => {
        pttActive = pressed;
      });
      manager.on("toggle-recording-triggered", () => {
        toggleTriggered = true;
      });

      pressKey(LINUX_KEYCODES.CTRL);
      pressKey(LINUX_KEYCODES.META);

      expect(pttActive).toBe(true);
      expect(toggleTriggered).toBe(false);
    });

    it("Ctrl+Meta+Space activates both PTT (subset) and toggle (exact)", () => {
      let pttActive = false;
      let toggleTriggered = false;
      manager.on("ptt-state-changed", (pressed: boolean) => {
        pttActive = pressed;
      });
      manager.on("toggle-recording-triggered", () => {
        toggleTriggered = true;
      });

      pressKey(LINUX_KEYCODES.CTRL);
      pressKey(LINUX_KEYCODES.META);
      pressNonModifier(LINUX_KEYCODES.SPACE);

      // PTT is subset match (Ctrl+Meta are pressed), toggle is exact match
      expect(pttActive).toBe(true);
      expect(toggleTriggered).toBe(true);
    });
  });
});
