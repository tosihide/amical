# Linux Helper (TypeScript)

Native helper process for Amical Desktop on Linux. Handles keyboard shortcut monitoring (evdev), audio recording control, text pasting, and notification sounds.

## System Dependencies

The following packages must be installed on the host system:

| Package | Min Version | Ubuntu Package | Purpose |
|---------|-------------|---------------|---------|
| wl-clipboard | 2.0+ | `wl-clipboard` | Clipboard read/write (Wayland) |
| ydotool | 0.1.8+ | `ydotool` | Keyboard simulation for paste (Ctrl+V) |
| GStreamer | 1.20+ | `gstreamer1.0-plugins-good` | Notification sound playback (mp3) |
| PulseAudio utils | 16.0+ | `pulseaudio-utils` | System audio mute/unmute (`pactl`) |
| PipeWire | 1.0+ | `pipewire-pulse` | Audio server (alternative to PulseAudio) |

### Install all dependencies (Ubuntu 24.04)

```bash
sudo apt install wl-clipboard ydotool gstreamer1.0-plugins-good pulseaudio-utils
```

### User group requirements

```bash
# Required for evdev keyboard monitoring
sudo usermod -aG input $USER
# Logout and login for group changes to take effect
```

## Architecture

```
bin/LinuxHelper          # Entry point (Node.js shebang script)
src/
  main.ts                # RPC dispatcher + evdev monitor startup
  evdev/
    monitor.ts           # Read-only evdev keyboard event monitoring
    keycodes.ts          # Linux evdev keycode → modifier flag mapping
  handlers/
    shortcuts.ts         # Store configured shortcut key arrays
    recording.ts         # System audio mute + notification sounds
    paste-text.ts        # Clipboard paste via wl-copy + ydotool
    accessibility.ts     # Stub (not implemented on Linux)
    recheck-pressed-keys.ts  # Verify pressed key state
  rpc/
    dispatcher.ts        # JSON-RPC message routing
    stdout-writer.ts     # Serialized stdout output
resources/
  rec-start.mp3          # Recording start notification sound
  rec-stop.mp3           # Recording stop notification sound
```

## Communication Protocol

The helper communicates with the Electron main process via JSON-RPC over stdin/stdout:

- **stdin**: Receives RPC requests from Electron (NativeBridge)
- **stdout**: Sends RPC responses and key events
- **stderr**: Debug/error logging (forwarded to Electron logs)

## Key Event Monitoring

Uses Linux evdev (`/dev/input/eventN`) in **read-only mode** (no EVIOCGRAB). Scans for keyboard devices by checking `/sys/class/input/*/device/capabilities/key`. Events are emitted as `keyDown`, `keyUp`, or `flagsChanged` (modifiers).

## Sound Playback

Uses `gst-play-1.0` (GStreamer) for mp3 playback. The playback process is spawned detached so it doesn't block the RPC response.

## Build

```bash
pnpm build    # Compiles TypeScript to dist/ and makes bin/LinuxHelper executable
```

## Tested On

- Ubuntu 24.04 LTS (Noble Numbat)
- Wayland (GNOME Shell)
- PipeWire 1.0.5 (with pipewire-pulse)
- Node.js 24+
