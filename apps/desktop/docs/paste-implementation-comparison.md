# Paste Implementation Comparison (macOS / Windows / Linux)

## Overview

Each platform's native helper handles the "paste transcription" operation differently.
This document compares the implementations to identify gaps and improvement opportunities.

## Comparison Table

| Aspect | macOS (Swift) | Windows (C#) | Linux (TS) |
|--------|--------------|--------------|------------|
| **Clipboard API** | `NSPasteboard.setString()` — synchronous, OS-native | `Clipboard.SetText()` — synchronous, OS-native | `wl-copy` — async external process, must stay resident |
| **Paste Simulation** | `CGEvent` posting Cmd+V directly to event tap | `SendInput` batch of Ctrl+V in single call | `ydotool` external process (Shift+Insert) |
| **Clipboard Save** | `NSPasteboardItem` clone per format (rich data) | All formats cloned to byte arrays (images, streams, text) | `wl-paste --no-newline` text only |
| **Clipboard Restore Wait** | `DispatchQueue.asyncAfter` (configurable delay) | `Thread.Sleep(700)` synchronous | `setTimeout(500)` async |
| **Modifier Interference** | N/A (CGEvent bypasses keyboard state) | `GetAsyncKeyState` detects held modifiers, releases them in same SendInput batch | None |
| **Paste Target Compatibility** | Universal (CGEvent goes to session event tap) | Universal (SendInput goes to foreground window) | GUI apps ✓, Terminals partial (Shift+Insert) |
| **Clipboard Ownership** | OS manages — pasteboard survives app exit | OS manages — clipboard survives app exit | Wayland: source app must stay alive to serve data (`wl-copy` stays resident) |

## Key Architectural Differences

### Clipboard Write Timing

**macOS/Windows**: Clipboard write is **synchronous** via OS API. The data is immediately available to any app requesting paste.

**Linux (Wayland)**: Clipboard is **selection-based** — the copying app (wl-copy process) must stay running to serve paste requests. This introduces race conditions:
1. `wl-copy` is spawned as a detached process
2. It takes ~100ms to set up
3. If paste keystroke fires before `wl-copy` is ready, the old clipboard content is pasted

### Paste Keystroke Delivery

**macOS**: `CGEvent` posts directly to the Core Graphics event tap — bypasses all keyboard state, works in all apps including terminals.

**Windows**: `SendInput` delivers input at the OS level in a **single atomic batch** — guaranteed ordering, works in all apps including terminals (Ctrl+V is universal on Windows).

**Linux**: `ydotool` is an external process that writes to `/dev/uinput`. It has:
- Process startup latency
- No atomic batching
- Different key combos needed for different app types (Ctrl+V for GUI, Ctrl+Shift+V for terminals)
- Using Shift+Insert as a compromise (works in most apps but reads from PRIMARY selection in some)

## Improvement Opportunity for Linux

### Use Electron's clipboard API

Instead of `wl-copy`, use Electron's built-in `clipboard.writeText()` in the main process:
- **Synchronous** — no race condition
- **Wayland-native** — Electron already handles the Wayland clipboard protocol
- **No external process** — eliminates wl-copy dependency for paste

The flow would be:
1. Electron main process: `clipboard.writeText(transcript)` (synchronous)
2. Linux helper: only simulate Shift+Insert keystroke via ydotool

This matches the macOS/Windows pattern where clipboard is set via OS API and only the keystroke is delegated to the native helper.

## Files

- macOS: `packages/native-helpers/swift-helper/Sources/SwiftHelper/AccessibilityService.swift`
- Windows: `packages/native-helpers/windows-helper/src/Services/AccessibilityService.cs` + `ClipboardService.cs`
- Linux: `packages/native-helpers/linux-helper-ts/src/handlers/paste-text.ts`
- Caller: `apps/desktop/src/main/managers/recording-manager.ts` (`pasteTranscription`)
