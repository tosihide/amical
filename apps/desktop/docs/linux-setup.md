# Linux Development Setup

Guide for building and running Amical Desktop on Linux (Ubuntu 24.04 LTS).

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
| ydotool | `ydotool` | 0.1.8+ | Keyboard simulation for paste |
| GStreamer good plugins | `gstreamer1.0-plugins-good` | 1.20+ | Notification sound playback (mp3) |
| PulseAudio utils | `pulseaudio-utils` | 16.0+ | System audio mute control (pactl) |

#### Required for Electron

| Package | Ubuntu Package | Purpose |
|---------|---------------|---------|
| libgtk-3 | `libgtk-3-0` | GTK windowing |
| libnss3 | `libnss3` | Chromium security |
| libasound2 | `libasound2t64` | ALSA audio |
| libgbm | `libgbm1` | GPU buffer management |

#### Audio server (one of)

| Package | Ubuntu Package | Purpose |
|---------|---------------|---------|
| PipeWire + PulseAudio compat | `pipewire-pulse` | Modern audio server (Ubuntu 24.04 default) |
| PulseAudio | `pulseaudio` | Legacy audio server |

### Install all dependencies

```bash
sudo apt install \
  wl-clipboard \
  ydotool \
  gstreamer1.0-plugins-good \
  pulseaudio-utils \
  libgtk-3-0 \
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

## Known Limitations

- **Electron sandbox**: Requires `ELECTRON_DISABLE_SANDBOX=1` or SUID setup for `chrome-sandbox`
- **OAuth flow**: Uses BrowserWindow instead of system browser (workaround for custom scheme handling on Linux)
- **Terminal paste**: `ydotool` simulates Ctrl+V which doesn't work in some terminals (use Ctrl+Shift+V)
- **ydotool versions**: Both v0.1.x (`ctrl+v` format) and v1.x (`29:1 47:1` format) are supported
