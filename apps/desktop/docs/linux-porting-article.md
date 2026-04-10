# Porting an Electron Desktop App to Linux --- Issues and Solutions for Clipboard, Key Input, and Notification Sounds

## Introduction

This article summarizes the problems encountered and their solutions when porting an Electron desktop app (a voice dictation tool) originally developed for macOS/Windows to Linux. OAuth-related topics are covered in a separate article; this article focuses on the remaining issues, specifically **clipboard operations**, **key input monitoring**, **notification sound playback**, **window management**, **helper processes**, and **initialization order**.

The target environment is Ubuntu 24.04 LTS / GNOME / Wayland.

---

## 1. Paste (Clipboard) Issue

### Problem

The feature that pastes speech recognition results into the active application did not work on Linux. On macOS/Windows, both clipboard read/write and keystroke simulation are delegated to native helpers, but on Linux, `wl-copy` operates asynchronously, causing a **race condition where the paste keystroke fires before the clipboard write completes**.

### Solution: Electron clipboard API + Division of Responsibilities with the Helper

The solution was to write to the clipboard synchronously from the Electron main process and delegate only keystroke sending to the helper.

```typescript
// recording-manager.ts
import { clipboard } from "electron";

if (isLinux()) {
  // Linux: use Electron clipboard API (synchronous, reliable) then
  // ask the helper only for the keystroke simulation.
  // This avoids the wl-copy async race condition.
  const savedClipboard = preserveClipboard
    ? clipboard.readText()
    : null;
  clipboard.writeText(transcription);

  void nativeBridge
    .call("pasteText", {
      transcript: transcription,
      preserveClipboard: false, // clipboard already set by Electron
      keystrokeOnly: true,
    })
    .then(() => {
      if (savedClipboard !== null) {
        setTimeout(() => {
          clipboard.writeText(savedClipboard);
        }, 500);
      }
    });
} else {
  // macOS/Windows: delegate everything to native helper
  void nativeBridge.call("pasteText", {
    transcript: transcription,
    preserveClipboard,
  });
}
```

The key detail is the `keystrokeOnly: true` flag. On the helper side, this flag causes the clipboard operation to be skipped, sending only the keystroke.

### Keystroke Choice: Shift+Insert

Another problem was **which keystroke to use for simulating paste**.

- `Ctrl+V` --- Does not work in terminal applications (terminals conventionally use `Ctrl+Shift+V`)
- `Ctrl+Shift+V` --- In VS Code, this opens the markdown preview instead of performing a plain text paste

Ultimately, `Shift+Insert` was adopted. This works in both GUI applications and terminals.

```typescript
// paste-text.ts (LinuxHelper side)
async function simulatePaste(): Promise<void> {
  try {
    // Try v0.1.x format first (more common on Ubuntu 24.04)
    await run("ydotool", ["key", "shift+Insert"]);
  } catch {
    // Fallback: try v1.x format (keycode 42=SHIFT, 110=INSERT)
    await run("ydotool", ["key", "42:1", "110:1", "110:0", "42:0"]);
  }
}
```

`ydotool` has different APIs depending on the version (v0.1.x uses key name format, v1.x and later uses keycode format), so a fallback for both is provided.

---

## 2. Key Input / Hotkeys --- Global Key Monitoring with evdev

### Problem

On macOS, global key input can be monitored with `CGEvent` taps, and on Windows with Low-Level Keyboard Hooks. Linux has no such built-in mechanism for Electron, and the `globalShortcut` API only supports modifier key combinations, making it insufficient for use cases like Push-to-Talk (recording only while a key is held down).

### Solution: Direct Reading of evdev Devices

The approach adopted was to directly open `/dev/input/eventN` devices and parse `input_event` structs.

```typescript
// evdev/monitor.ts
// struct input_event on 64-bit:
// { uint64 sec, uint64 usec, uint16 type, uint16 code, int32 value }
const INPUT_EVENT_SIZE = 24;
const EV_KEY = 1;

function parseInputEvent(
  buf: Buffer,
  offset: number,
): { type: number; code: number; value: number } | null {
  if (buf.length - offset < INPUT_EVENT_SIZE) return null;
  const type = buf.readUInt16LE(offset + 16);
  const code = buf.readUInt16LE(offset + 18);
  const value = buf.readInt32LE(offset + 20);
  return { type, code, value };
}
```

Keyboard devices are identified by reading `/sys/class/input/eventN/device/capabilities/key` and treating devices with more than 20 bits set as "keyboards." This prevents accidentally monitoring mice, gamepads, and other devices.

```typescript
// evdev/monitor.ts
function scanKeyboardDevices(): string[] {
  const devices: string[] = [];
  const entries = fs.readdirSync("/dev/input");
  for (const entry of entries) {
    if (!entry.startsWith("event")) continue;
    const capsPath = `/sys/class/input/${entry}/device/capabilities/key`;
    const caps = fs.readFileSync(capsPath, "utf-8").trim();
    const parts = caps.split(" ");
    const totalBits = parts.reduce((sum, hex) => {
      let count = 0;
      let n = BigInt(`0x${hex}`);
      while (n) {
        count += Number(n & 1n);
        n >>= 1n;
      }
      return sum + count;
    }, 0);
    // Real keyboards have many key capabilities (>20 bits set)
    if (totalBits > 20) {
      devices.push(`/dev/input/${entry}`);
    }
  }
  return devices;
}
```

> **Prerequisite**: The user must be a member of the `input` group (`sudo usermod -aG input $USER`).

### evdev Keycode Mapping

macOS and Windows each use their own keycode systems, while Linux uses evdev keycodes as the standard. Mapping tables for all three platforms are prepared, and the appropriate one is selected at runtime based on the platform.

```typescript
// keycode-map.ts
const linuxEvdevToKey: Record<number, string> = {
  // Modifier keys
  29: "Ctrl",
  97: "RCtrl",
  42: "Shift",
  54: "RShift",
  56: "Alt",
  100: "RAlt",
  125: "Cmd", // Super/Meta left (mapped to Cmd for consistency)
  126: "RCmd",
  464: "Fn",
  // Letters (evdev codes 16-50 follow QWERTY layout)
  16: "Q", 17: "W", 18: "E", /* ... */
  // ...over 130 keys supported
};

export function getKeyFromKeycode(keycode: number): string | undefined {
  const mapping = isLinux()
    ? linuxEvdevToKey
    : isWindows()
      ? windowsVKToKey
      : macOSKeycodeToKey;
  return mapping[keycode];
}
```

### Default Shortcuts

After searching for a key on Linux that is unlikely to conflict with other applications --- similar to the `Fn` key on macOS --- `Ctrl+Super` was adopted for Push-to-Talk.

```typescript
// app-settings.ts
if (isLinux()) {
  return {
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
}
```

---

## 3. Notification Sounds --- Audio Playback on Linux

### Problem

On macOS, `NSSound` is available, and on Windows, the `PlaySound` API makes it easy to play sound effects. Linux has no unified audio playback API.

### Solution: Launch GStreamer as a Detached Process

The approach adopted was to launch `gst-play-1.0` (GStreamer's command-line player) as a detached process. This avoids blocking RPC responses.

```typescript
// handlers/recording.ts (LinuxHelper)
function playSound(soundName: string): void {
  const soundFile = path.join(getResourcesDir(), `${soundName}.mp3`);
  if (!fs.existsSync(soundFile)) {
    process.stderr.write(`Sound file not found: ${soundFile}\n`);
    return;
  }

  const child = spawn("gst-play-1.0", [soundFile], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  child.on("error", () => {
    process.stderr.write(`gst-play-1.0 not available, sound skipped\n`);
  });
}
```

The feature that mutes system audio during recording (to prevent the user's voice from being output through speakers) uses `pactl` (PulseAudio/PipeWire CLI tool).

```typescript
// Mute system audio when recording starts
await execFileAsync("pactl", ["set-sink-mute", "@DEFAULT_SINK@", "1"]);

// Unmute when recording ends
await execFileAsync("pactl", ["set-sink-mute", "@DEFAULT_SINK@", "0"]);
```

---

## 4. Window Management --- Linux-Specific Window Settings

### Problem

On macOS, `titleBarStyle: "hiddenInset"` + vibrancy creates a native-feeling window. On Windows, `titleBarStyle: "hidden"` + `titleBarOverlay` achieves a custom title bar. However, on Linux, neither approach works as expected, and rendering artifacts can occur.

### Solution: Use the Default Frame on Linux

On Linux, instead of forcing customization, the default OS window frame is used as-is.

```typescript
// window-manager.ts
this.mainWindow = new BrowserWindow({
  frame: true,
  backgroundColor:
    process.platform === "darwin" ? "#00000000" : colors.backgroundColor,
  ...(process.platform === "darwin"
    ? {
        titleBarStyle: "hiddenInset",
        vibrancy: "menu",
      }
    : process.platform === "linux"
      ? {} // Linux: use default OS frame, no custom title bar
      : {
          titleBarStyle: "hidden",
          titleBarOverlay: {
            color: colors.backgroundColor,
            symbolColor: colors.symbolColor,
            height: 32,
          },
        }),
});
```

The same applies to the onboarding window.

```typescript
// window-manager.ts (onboarding window)
this.onboardingWindow = new BrowserWindow({
  frame: true,
  ...(process.platform === "linux"
    ? {} // Linux: default frame
    : {
        titleBarStyle: "hidden" as const,
        titleBarOverlay: { /* ... */ },
      }),
});
```

In the `process.platform === "linux"` case, an empty object `{}` is spread, so nothing is added and `frame: true` remains as-is. Simple but reliable.

---

## 5. LinuxHelper --- The Role of the Helper Process

macOS has `SwiftHelper` (written in Swift), and Windows has `WindowsHelper.exe`, but Linux initially had no native helper. A new **LinuxHelper** was created in TypeScript (Node.js).

### Architecture

LinuxHelper is launched as a child process and communicates with the Electron main process via JSON-RPC over stdin/stdout.

```typescript
// main.ts (LinuxHelper)
import { startKeyboardMonitor } from "./evdev/monitor.js";

// Start evdev keyboard monitoring in parallel
startKeyboardMonitor();

// Read JSON-RPC requests from stdin (one JSON object per line)
const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on("line", (line: string) => {
  const request = JSON.parse(line.trim());
  dispatch(request);
});
```

### Provided RPC Methods

| Method | Role |
|---|---|
| `pasteText` | Clipboard operation + paste keystroke |
| `startRecording` | Start recording (play notification sound, system mute) |
| `stopRecording` | Stop recording (unmute, play notification sound) |
| `setShortcuts` | Pass shortcut key configuration |
| `recheckPressedKeys` | Recheck currently pressed keys |
| `getAccessibilityContext` | Get active window information |
| `getAccessibilityStatus` | Check required commands/permissions |

### Getting the Active Window

Active window information is retrieved via GNOME's D-Bus.

```typescript
// handlers/accessibility.ts
async function getGnomeActiveWindow() {
  const script = `
    (function() {
      let w = global.display.get_focus_window();
      if (!w) return JSON.stringify({title: null, wmClass: null, pid: 0});
      return JSON.stringify({
        title: w.get_title(),
        wmClass: w.get_wm_class(),
        pid: w.get_pid()
      });
    })()
  `;

  const { stdout } = await execFileAsync("gdbus", [
    "call", "--session",
    "--dest", "org.gnome.Shell",
    "--object-path", "/org/gnome/Shell",
    "--method", "org.gnome.Shell.Eval",
    script,
  ]);
  // ...
}
```

### Platform Detection and Helper Name Resolution

```typescript
// platform.ts
export function getNativeHelperName(): string {
  if (isWindows()) return "WindowsHelper.exe";
  if (isLinux()) return "LinuxHelper";
  return "SwiftHelper";
}

export function getNativeHelperDir(): string {
  if (isWindows()) return "windows-helper";
  if (isLinux()) return "linux-helper-ts";
  return "swift-helper";
}
```

---

## 6. Initialization Order Differences --- Deferred Initialization of Recording Services

### Problem

When the Electron app starts, OAuth authentication is performed during the onboarding (initial setup) flow. On Linux, when NativeBridge (LinuxHelper) startup and the BrowserWindow-based OAuth authentication flow run concurrently, the `amical://` protocol handler conflicts, triggering a second-instance event that causes the pending authentication state to be lost.

### Solution: Deferred Initialization of Recording Services on Linux Only

```typescript
// app-manager.ts
if (onboardingCheck.needed) {
  // On Linux, defer recording services (NativeBridge/evdev) until after
  // onboarding. The BrowserWindow-based OAuth flow on Linux conflicts
  // with the amical:// protocol handler, causing second-instance launches
  // that lose the pending auth state.
  if (!isLinux()) {
    await this.initializeRecordingServices();
  }
  await onboardingService.startOnboardingFlow();
  await this.windowManager.createOrShowOnboardingWindow();
} else {
  await this.initializeRecordingServices();
  await this.setupWindows();
}
```

Similarly, after onboarding completes in development mode, on Linux the recording services are initialized first before setting up windows.

```typescript
// app-manager.ts (onboarding completed event)
onboardingService.on("completed", () => {
  if (shouldRelaunch) {
    app.relaunch();
    app.quit();
  } else {
    const setup = isLinux()
      ? this.initializeRecordingServices().then(() => this.setupWindows())
      : this.setupWindows();
    setup.catch((error) => { /* ... */ });
  }
});
```

---

## 7. Shortcut Key Settings --- Why Intercepting Key Events Was Necessary

### Background: The Shortcut Key Change UI

In this app, users can freely change shortcut keys for Push-to-Talk (record while holding), Toggle Recording (toggle recording on/off), and other actions in the settings screen. The change UI uses a "recording mode" approach. When the user clicks the pencil icon, it enters a recording state; when the user actually presses keys, that combination is registered as the new shortcut. Validation runs the moment the keys are released, and if there are no issues, the shortcut is saved.

```
[Settings Screen]
  Push-to-Talk: [Ctrl+Super]  ✏️  ← Click to start recording
                ↓
  Push-to-Talk: [Press keys...]  ✕  ← Press keys in this state
                ↓
  Push-to-Talk: [Alt+Shift]  ← Confirmed when keys are released
```

### Problem: Electron's Standard Keyboard Events Are Insufficient

In the macOS/Windows implementation, ShortcutManager receives key events from each OS's native helper (SwiftHelper / WindowsHelper) and tracks currently pressed keys in ShortcutManager's `activeKeys` map. The settings screen React component (`ShortcutInput`) receives `activeKeys` changes in real-time via tRPC Subscription.

There were two Linux-specific problems here.

**1. Electron's `keydown`/`keyup` events only fire when the window has focus**

Global shortcuts like Push-to-Talk must work even when the app is in the background. Electron's standard keyboard events are only available when a BrowserWindow has focus, and the `globalShortcut` API only allows registering specific key combinations. macOS/Windows achieved low-level key hooks through each OS's native APIs, but Linux has no equivalent mechanism.

**2. evdev keycodes and Electron keycodes are entirely different systems**

The keycodes emitted by the Linux kernel's evdev are completely different numbering systems from macOS's CGEvent keycodes and Windows's Virtual Key codes. For example, the same `A` key is macOS=0, Windows=0x41, evdev=30. Since shortcut settings are stored as keycode arrays, **key capture in the settings screen must also use evdev keycodes consistently**.

### Solution: Use the Native Helper's Key Event Stream Directly in the Settings Screen

The key design decision was to **use the same key event source for both shortcut execution (global key monitoring) and shortcut configuration (UI key capture)**.

#### evdev Monitor -> ShortcutManager -> tRPC Subscription -> React UI

The data flow is as follows.

```
/dev/input/eventN (evdev device)
    ↓ Read binary via fs.read()
LinuxHelper (evdev/monitor.ts)
    ↓ Write as JSON-RPC event to stdout
NativeBridge (native-bridge-service.ts)
    ↓ Emit as "helperEvent" event
ShortcutManager (shortcut-manager.ts)
    ↓ Update activeKeys map, emit "activeKeysChanged"
tRPC Subscription (settings.ts: activeKeysUpdates)
    ↓ Deliver to renderer via WebSocket
ShortcutInput (shortcut-input.tsx)
    ↓ Update React state, display keys in UI
```

#### ShortcutManager's "Recording Mode"

While the settings screen is capturing keys, ShortcutManager sets the `isRecordingShortcut` flag to ON. While this flag is ON, shortcut execution checks (`checkShortcuts`) are skipped, and key events are used purely for delivery to the UI.

```typescript
// shortcut-manager.ts
setIsRecordingShortcut(isRecording: boolean) {
  this.isRecordingShortcut = isRecording;
  // ...
}

private checkShortcuts() {
  // Skip shortcut detection when recording shortcuts
  if (this.isRecordingShortcut) {
    return;
  }
  // ...PTT, Toggle, etc. detection logic
}
```

The settings screen React component calls `setShortcutRecordingState(true)` via tRPC mutation when recording starts, and sets it back to `false` on completion or cancellation.

```typescript
// shortcut-input.tsx
const handleStartRecording = () => {
  onRecordingShortcutChange(true);
  setRecordingStateMutation.mutate(true);  // メインプロセスに通知
};

// tRPCのSubscriptionで、evdev由来のキーイベントをリアルタイム受信
api.settings.activeKeysUpdates.useSubscription(undefined, {
  enabled: isRecordingShortcut,
  onData: (keys: number[]) => {
    const previousKeys = activeKeys;
    setActiveKeys(keys);

    // キーが離されたら → 直前の組み合わせでバリデーション
    if (previousKeys.length > 0 && keys.length < previousKeys.length) {
      const result = validateShortcutFormat(previousKeys);
      if (result.valid && result.shortcut) {
        onChange(result.shortcut);  // 親コンポーネントへ通知
      }
      // ...
    }
  },
});
```

#### Modifier Key Handling on Linux: flagsChanged

In macOS's CGEvent, modifier key (Cmd, Ctrl, Shift, Alt) press/release events are reported as a distinct event type called `flagsChanged`, rather than regular keyDown/keyUp. The Linux evdev monitor follows this macOS-style design and emits modifier keys as `flagsChanged` events.

```typescript
// evdev/monitor.ts
if (value === 1) {  // key press
  pressedKeys.add(code);
  emitKeyEvent(
    isModifierKeyCode(code) ? "flagsChanged" : "keyDown",
    code,
  );
} else if (value === 0) {  // key release
  pressedKeys.delete(code);
  emitKeyEvent(
    isModifierKeyCode(code) ? "flagsChanged" : "keyUp",
    code,
  );
}
```

On the ShortcutManager side, when a `flagsChanged` event is received, if the keycode is already tracked it is treated as a release (keyUp equivalent); otherwise, it is treated as a press (keyDown equivalent).

```typescript
// shortcut-manager.ts
case "flagsChanged":
  // Modifier keys (Ctrl, Shift, Alt, Meta) are sent as flagsChanged.
  // Treat as keyDown if not tracked, keyUp if already tracked.
  if (this.activeKeys.has(event.payload.keyCode)) {
    this.handleKeyUp(event.payload);
  } else {
    this.handleKeyDown(event.payload);
  }
  break;
```

### Platform-Based Keycode Switching

Key names displayed on the settings screen and keycodes used for saving/loading are all platform-specific values. The `getKeyFromKeycode()` function determines the platform at runtime and selects the appropriate mapping table.

```typescript
// keycode-map.ts — Holds mapping tables for all 3 platforms
const linuxEvdevToKey: Record<number, string> = {
  29: "Ctrl", 97: "RCtrl",
  42: "Shift", 54: "RShift",
  56: "Alt", 100: "RAlt",
  125: "Cmd",  // Super/Meta left — labeled as Cmd for consistency
  126: "RCmd",
  57: "Space", 28: "Enter",
  // ...over 130 keys supported
};

export function getKeyFromKeycode(keycode: number): string | undefined {
  const mapping = isLinux()
    ? linuxEvdevToKey
    : isWindows()
      ? windowsVKToKey
      : macOSKeycodeToKey;
  return mapping[keycode];
}
```

### Unified Validation

Shortcut validation (checking for conflicts with OS-reserved shortcuts, checking for duplicate modifier keys, etc.) is consolidated in `shortcut-validation.ts`. The Linux version currently omits OS-reserved shortcut checks (because reserved shortcuts differ significantly across Linux desktop environments), but other checks (maximum key count, conflicts with other shortcuts, prohibiting alphanumeric-only shortcuts without modifiers, etc.) are applied uniformly across all platforms.

### Summary

In a typical Electron app, changing key bindings in the settings screen can be done simply by capturing browser `keydown` events with `addEventListener`. However, in this app, the following reasons led to a design that uses evdev --- a low-level key event source --- directly in the settings screen as well.

1. **Keycode consistency** --- If different keycodes are used for shortcut execution (background) and configuration (foreground), saved shortcuts will not fire correctly
2. **Standalone modifier key detection** --- Browser `keydown` events are unreliable for detecting a solo `Ctrl` press, and `keyup` timing cannot be trusted. evdev provides reliable detection
3. **Uniform architecture across all platforms** --- macOS/Windows/Linux all use the same pipeline: "native helper -> ShortcutManager -> tRPC Subscription -> React UI." Platform branching is confined to the helper and keycode mapping, and the UI component code is completely shared

---

## Summary

Here is a summary of the main problems encountered and their solutions when porting an Electron app to Linux.

| Area | Problem | Solution |
|---|---|---|
| Clipboard | Race condition due to `wl-copy` asynchronous behavior | Synchronous write with Electron clipboard API; helper handles keystrokes only |
| Paste | `Ctrl+V` does not work in terminals | Adopted `Shift+Insert` (works in both GUI and terminal) |
| Key input monitoring | No equivalent to global key hooks | Direct reading of evdev devices (`input` group required) |
| Keycodes | Different keycode systems across OSes | Mapping tables for all 3 platforms |
| Shortcut settings UI | Unreliable standalone modifier key detection with browser keydown | Deliver evdev events to settings UI directly via tRPC Subscription |
| Notification sounds | No unified audio playback API | Launch `gst-play-1.0` as a detached process |
| System mute | Preventing feedback during recording | Mute/unmute default sink with `pactl` |
| Windows | Custom title bar does not render correctly | Use default window frame on Linux |
| Helper | Executing OS-specific functionality | TypeScript-based LinuxHelper (JSON-RPC over stdin/stdout) |
| Initialization order | Conflict between OAuth and protocol handler | Deferred initialization of recording services (Linux only) |
| Active window | OS-dependent method for retrieving window info | Retrieve via GNOME D-Bus eval |

### External Dependencies

The Linux version requires the following tools:

- **ydotool** --- Keystroke simulation
- **wl-copy / wl-paste** --- Wayland clipboard operations (fallback)
- **gst-play-1.0** --- MP3 audio file playback
- **pactl** --- PulseAudio/PipeWire sink control
- **gdbus** --- GNOME Shell D-Bus communication

Electron is often described as "write once, run anywhere," but platform-specific adaptations are essential for features that depend on OS-specific functionality. On Linux in particular, we encountered challenges unique to the Wayland transition era (the X11-era `xdotool` cannot be used and `ydotool` is needed instead, the clipboard is `wl-copy`-based, etc.).

I hope this article serves as a useful reference for anyone considering Linux support for their Electron app.
