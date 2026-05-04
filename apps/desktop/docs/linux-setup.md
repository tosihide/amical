# Linux Development Setup

Guide for building and running Amical Desktop on Linux (Ubuntu 26.04 LTS).

## Prerequisites

### Node.js & pnpm

```bash
# Node.js 24+ required (see .nvmrc or engines in package.json)
nvm install 24
nvm use 24

# pnpm 10+ (specified in packageManager field)
corepack enable
```

### System Dependencies

#### Required for the Linux Helper

| Package | Ubuntu Package | Version | Purpose |
|---------|---------------|---------|---------|
| wl-clipboard | `wl-clipboard` | 2.0+ | Wayland clipboard (wl-copy/wl-paste) |
| ydotool | `ydotool` | 1.0+ | Keyboard simulation for paste |
| GStreamer good plugins | `gstreamer1.0-plugins-good` | 1.20+ | Notification sound playback (mp3) |
| PulseAudio utils | `pulseaudio-utils` | 16.0+ | System audio mute control (pactl) |

#### Required for Electron

| Package | Ubuntu Package | Purpose |
|---------|---------------|---------|
| libgtk-3 | `libgtk-3-0t64` | GTK windowing |
| libnss3 | `libnss3` | Chromium security |
| libasound2 | `libasound2t64` | ALSA audio |
| libgbm | `libgbm1` | GPU buffer management |

#### Audio server (one of)

| Package | Ubuntu Package | Purpose |
|---------|---------------|---------|
| PipeWire + PulseAudio compat | `pipewire-pulse` | Modern audio server (Ubuntu 26.04 default) |
| PulseAudio | `pulseaudio` | Legacy audio server |

### Install all dependencies

```bash
sudo apt install \
  wl-clipboard \
  ydotool \
  gstreamer1.0-plugins-good \
  pulseaudio-utils \
  libgtk-3-0t64 \
  libnss3 \
  libasound2t64 \
  libgbm1
```

### User Groups

```bash
# Required for evdev keyboard monitoring (global shortcuts)
sudo usermod -aG input $USER
# Logout and login for group changes to take effect
```

## Environment Setup

Copy `.env.example` and configure:

```bash
cd apps/desktop
cp .env.example .env
```

Required `.env` values:

```env
AUTH_CLIENT_ID=<your-oauth-client-id>
AUTHORIZATION_ENDPOINT=https://core.amical.ai/api/auth/oauth2/authorize
AUTH_LOGIN_URL=https://login.amical.ai/auth/sign-in
AUTH_TOKEN_ENDPOINT=https://core.amical.ai/api/auth/oauth2/token
AUTH_REDIRECT_URI=amical://oauth/callback
API_ENDPOINT=https://dictation.amical.ai
```

## Running in Development

```bash
# From the repository root
cd apps/desktop
ELECTRON_DISABLE_SANDBOX=1 pnpm start
```

`ELECTRON_DISABLE_SANDBOX=1` is required because the Electron sandbox binary (`chrome-sandbox`) is not SUID root in development.

## Building Linux Helper

The Linux helper is a TypeScript Node.js process (not a native binary):

```bash
cd packages/native-helpers/linux-helper-ts
pnpm build
```

## Packaging

```bash
cd apps/desktop
pnpm make:linux    # Creates .deb and .rpm packages
pnpm package:linux # Creates unpacked app directory
```

## Diagnostics

### Microphone Check

```bash
node apps/desktop/tests/scripts/check-microphone.mjs
```

Verifies:
- Audio server (PipeWire/PulseAudio) is running
- Audio input devices are available
- Default input device is set
- Audio capture works

### Keyboard Shortcut Defaults

| Action | Shortcut |
|--------|----------|
| Push-to-Talk | Ctrl + Meta (Super) |
| Hands-free Toggle | Ctrl + Meta + Space |
| Paste Last Transcript | Alt + Shift + V |
| New Note | Alt + Shift + N |

## XKB Key Remapping Support

The Linux helper reads raw evdev keycodes, which bypass X11/Wayland-level key remapping. If you use `setxkbmap` options like `ctrl:swapcaps` (CapsLock ↔ Ctrl swap), the helper automatically detects this at startup and applies the remapping so that shortcuts work as expected.

Supported xkb options:

| Option | Effect |
|--------|--------|
| `ctrl:swapcaps` | CapsLock ↔ Left Ctrl swap |
| `ctrl:nocaps` / `ctrl:ctrl_ac` | CapsLock acts as Ctrl |

Verify your current xkb options:

```bash
setxkbmap -query | grep options
```

If you change xkb options while Amical is running, restart the app for the new mapping to take effect. The helper logs `XKB remap loaded: 58->29, 29->58` at startup when remapping is active.

## Known Limitations

- **Electron sandbox**: Requires `ELECTRON_DISABLE_SANDBOX=1` or SUID setup for `chrome-sandbox`
- **OAuth flow**: Uses BrowserWindow instead of system browser (workaround for custom scheme handling on Linux)
- **Wayland required for paste**: The paste feature uses `wl-copy`/`wl-paste` (Wayland clipboard) and `ydotool`. On X11 sessions, paste will not work — log in with a Wayland session instead
- **Terminal paste**: `ydotool` simulates Shift+Insert which works in most terminals, but some may need configuration
