import { describe, it, expect, vi, beforeEach } from "vitest";
import { LINUX_KEYCODES, MAC_KEYCODES, WINDOWS_KEYCODES } from "../../src/utils/keycodes";

describe("getDefaultShortcuts", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadWithPlatform(platform: string) {
    vi.doMock("../../src/utils/platform", () => ({
      isMacOS: () => platform === "darwin",
      isLinux: () => platform === "linux",
      isWindows: () => platform === "win32",
    }));
    // Dynamic import after mock to pick up the mocked platform
    const { getDefaultShortcuts } = await import("../../src/db/app-settings");
    return getDefaultShortcuts();
  }

  describe("Linux defaults", () => {
    it("pushToTalk should be Ctrl+Meta", async () => {
      const shortcuts = await loadWithPlatform("linux");
      expect(shortcuts.pushToTalk).toEqual([
        LINUX_KEYCODES.CTRL,
        LINUX_KEYCODES.META,
      ]);
    });

    it("toggleRecording (hands-free) should be Ctrl+Meta+Space", async () => {
      const shortcuts = await loadWithPlatform("linux");
      expect(shortcuts.toggleRecording).toEqual([
        LINUX_KEYCODES.CTRL,
        LINUX_KEYCODES.META,
        LINUX_KEYCODES.SPACE,
      ]);
    });

    it("pasteLastTranscript should be Alt+Shift+V", async () => {
      const shortcuts = await loadWithPlatform("linux");
      expect(shortcuts.pasteLastTranscript).toEqual([
        LINUX_KEYCODES.ALT,
        LINUX_KEYCODES.SHIFT,
        LINUX_KEYCODES.V,
      ]);
    });

    it("newNote should be Alt+Shift+N", async () => {
      const shortcuts = await loadWithPlatform("linux");
      expect(shortcuts.newNote).toEqual([
        LINUX_KEYCODES.ALT,
        LINUX_KEYCODES.SHIFT,
        LINUX_KEYCODES.N,
      ]);
    });
  });

  describe("macOS defaults", () => {
    it("pushToTalk should be Fn", async () => {
      const shortcuts = await loadWithPlatform("darwin");
      expect(shortcuts.pushToTalk).toEqual([MAC_KEYCODES.FN]);
    });

    it("toggleRecording should be Fn+Space", async () => {
      const shortcuts = await loadWithPlatform("darwin");
      expect(shortcuts.toggleRecording).toEqual([
        MAC_KEYCODES.FN,
        MAC_KEYCODES.SPACE,
      ]);
    });
  });

  describe("Windows defaults", () => {
    it("pushToTalk should be Ctrl+Win", async () => {
      const shortcuts = await loadWithPlatform("win32");
      expect(shortcuts.pushToTalk).toEqual([
        WINDOWS_KEYCODES.CTRL,
        WINDOWS_KEYCODES.WIN,
      ]);
    });

    it("toggleRecording should be Ctrl+Win+Space", async () => {
      const shortcuts = await loadWithPlatform("win32");
      expect(shortcuts.toggleRecording).toEqual([
        WINDOWS_KEYCODES.CTRL,
        WINDOWS_KEYCODES.WIN,
        WINDOWS_KEYCODES.SPACE,
      ]);
    });
  });
});
