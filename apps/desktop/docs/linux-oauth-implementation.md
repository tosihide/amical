# Linux OAuth Implementation - Technical Documentation

## Overview

This document details the implementation of OAuth2 PKCE authentication for Amical Desktop on Linux (Ubuntu 24.04). The implementation required significant deviation from the macOS/Windows approach due to fundamental differences in how Linux handles custom URL schemes.

## Problem Statement

Amical uses OAuth2 PKCE flow with `amical://oauth/callback` as the redirect URI. On macOS and Windows, the OS natively routes custom scheme URLs to the registered application. On Linux, this mechanism is broken in development mode:

1. `xdg-open` truncates custom scheme URLs to just `amical://` (path and query params lost)
2. Chromium (Electron's engine) strips custom scheme URLs in navigation events (`will-navigate`, `will-redirect`)
3. `app.setAsDefaultProtocolClient()` doesn't work reliably in dev mode with electron-forge
4. The single-instance lock doesn't connect between `pnpm start` (electron-forge) and direct `electron` invocations

## Investigation Timeline

### Phase 1: Understanding the macOS/Windows Flow

The production OAuth flow (macOS/Windows):
1. App opens `https://login.amical.ai/auth/sign-in?...` in system browser
2. User logs in
3. Server redirects to `amical://oauth/callback?code=XXX&state=YYY`
4. OS routes the URL to the Electron app
5. `app.on('open-url')` (macOS) or `second-instance` event (Windows) receives the full URL
6. App extracts `code` and `state`, exchanges for tokens

### Phase 2: Linux Deep Link Failures

**Attempt 1: xdg-open + .desktop file**
- Created `~/.local/share/applications/amical-dev.desktop` with `amical://` scheme handler
- Result: URL truncated to `amical://` in all cases
- Root cause: xdg-open and/or the desktop entry handler strips path/query from custom scheme URLs

**Attempt 2: single-instance lock**
- `app.requestSingleInstanceLock()` works between identical launch commands
- But electron-forge's `pnpm start` and the .desktop file's direct `electron` invocation have different app paths
- Result: Second instance starts instead of sending URL to existing instance

### Phase 3: BrowserWindow Approach

Switched to opening the login page inside an Electron BrowserWindow instead of the system browser. This avoids xdg-open entirely.

**Attempt 3: `will-navigate` event**
- Registered `will-navigate` handler on the BrowserWindow
- Result: Fires, but URL is `amical://` (truncated by Chromium)

**Attempt 4: `webRequest.onBeforeRedirect`**
- Network-level redirect monitoring
- Result: Did not fire for JavaScript-initiated navigations (the SPA uses `location.href`)

**Attempt 5: `protocol.registerSchemesAsPrivileged` + `standard: true`**
- Registered `amical` as a standard scheme before `app.whenReady()`
- Result: `SyntaxError: 'amical://' is not a valid URL` - the SPA page crashed because Chromium now validates custom scheme URLs strictly

**Attempt 6: `protocol.registerSchemesAsPrivileged` + `standard: false`**
- Registered with `standard: false` to avoid validation
- Result: PASS in standalone test scripts, but FAIL in actual app
- Root cause: Vite bundles the entry-point code at the END of the output file, so `registerSchemesAsPrivileged` runs AFTER `app.whenReady()` instead of before

**Attempt 7: Vite plugin to inject code at bundle top**
- Created a Vite plugin with `generateBundle` hook
- Result: Hook doesn't fire in electron-forge dev mode

### Phase 4: Discovering the Real OAuth Architecture

Using Playwright browser automation, we discovered the actual server-side flow:

```
POST /api/auth/sign-in/email
  -> Sets session cookie (better-auth.session_token)
  -> Returns user info + token

SPA navigates to https://login.amical.ai/
  -> Shows "Open Amical" page with <a href="amical://"> (NO code/state!)
  -> The SPA does NOT implement OAuth code redirect

GET /api/auth/oauth2/authorize?client_id=...&redirect_uri=amical://oauth/callback&...
  -> 302 redirect to amical://oauth/callback?code=XXX&state=YYY
  -> This is a SEPARATE endpoint from the SPA login page
```

**Key Discovery**: The SPA login page and the OAuth authorize endpoint are two separate systems:
- `login.amical.ai/auth/sign-in` = SPA login (sets session cookie, no OAuth code)
- `core.amical.ai/api/auth/oauth2/authorize` = OAuth authorize endpoint (requires session cookie, returns code)

The correct flow requires TWO steps:
1. Log in via the SPA to get a session cookie
2. Navigate to the authorize endpoint WITH that cookie to get the OAuth code

### Phase 5: Working Solution

**Attempt 8: `webRequest.onHeadersReceived` with dedicated session**

The authorize endpoint returns a standard HTTP 302 redirect. At the network level, the `Location` header contains the FULL `amical://oauth/callback?code=XXX&state=YYY` URL. By reading this header before Chromium processes the redirect, we bypass all URL truncation.

A dedicated session partition (`auth-oauth`) prevents conflicts with the main app's webRequest handlers.

## Final Implementation

### Architecture

```
┌─────────────────────────────────────────────────────┐
│ Electron Main Process                               │
│                                                     │
│  AuthService.login()                                │
│    │                                                │
│    ├─ [macOS/Windows] shell.openExternal(authUrl)   │
│    │   └─ OS handles amical:// deep link            │
│    │                                                │
│    └─ [Linux] openAuthWindow(loginUrl, authorizeUrl)│
│         │                                           │
│         ├─ Step 1: BrowserWindow loads login page   │
│         │   └─ User enters credentials              │
│         │   └─ SPA sets session cookie              │
│         │   └─ SPA navigates to login.amical.ai/    │
│         │                                           │
│         ├─ Step 2: did-navigate-in-page detected    │
│         │   └─ loadURL(authorizeUrl) with cookie    │
│         │                                           │
│         ├─ Step 3: Server returns 302               │
│         │   └─ onHeadersReceived reads Location     │
│         │   └─ Full amical://...?code=XXX captured  │
│         │                                           │
│         └─ Step 4: handleAuthCallback(code, state)  │
│             └─ Token exchange via POST              │
│             └─ Tokens stored in SQLite DB           │
└─────────────────────────────────────────────────────┘
```

### Key Files Modified

| File | Change |
|------|--------|
| `src/services/auth-service.ts` | Added `openAuthWindow()` with two-step flow, `onHeadersReceived` interception, dedicated session |
| `src/main/main.ts` | Removed `protocol` import (no longer needed) |
| `src/main/managers/service-manager.ts` | Skip ShortcutManager when NativeBridge unavailable |
| `src/main/core/app-manager.ts` | Skip shortcut event listeners when shortcutManager null |
| `src/main/core/window-manager.ts` | Use native frame on Linux (no titleBarOverlay) |
| `src/services/onboarding-service.ts` | Guard macOS-only `getMediaAccessStatus` |
| `src/trpc/routers/onboarding.ts` | Guard macOS-only `getMediaAccessStatus` |
| `apps/desktop/package.json` | Fix `build:native-helper` for Linux |
| `apps/desktop/.env` | OAuth endpoints configuration |
| `vite.main.config.mts` | Cleaned up (removed scheme registration plugin) |

### Environment Configuration

```bash
# apps/desktop/.env
AUTH_CLIENT_ID=5a0dc096e6174e5f9eec0403b2a69a24
AUTHORIZATION_ENDPOINT=https://core.amical.ai/api/auth/oauth2/authorize
AUTH_LOGIN_URL=https://login.amical.ai/auth/sign-in
AUTH_TOKEN_ENDPOINT=https://core.amical.ai/api/auth/oauth2/token
AUTH_REDIRECT_URI=amical://oauth/callback
API_ENDPOINT=https://api.amical.ai
```

**Important**: The `AUTH_CLIENT_ID` was extracted from the Windows app's OAuth authorization URL. The `.env.example` has a placeholder value. The `AUTHORIZATION_ENDPOINT` must point to `core.amical.ai` (the actual API backend), NOT `login.amical.ai` (the SPA frontend).

### OAuth Endpoint Discovery

| Endpoint | URL | Purpose |
|----------|-----|---------|
| Login (SPA) | `https://login.amical.ai/auth/sign-in` | User authentication UI |
| Sign-in API | `https://core.amical.ai/api/auth/sign-in/email` | Credential validation |
| Session check | `https://core.amical.ai/api/auth/get-session` | Session status |
| OAuth Authorize | `https://core.amical.ai/api/auth/oauth2/authorize` | OAuth code grant (302 redirect) |
| Token Exchange | `https://core.amical.ai/api/auth/oauth2/token` | Code-to-token exchange |

Note: `api.amical.ai` does not resolve; `core.amical.ai` is the actual backend.

## Approaches Tested (Summary)

| # | Approach | Result | Why |
|---|----------|--------|-----|
| 1 | xdg-open + .desktop file | FAIL | URL truncated by Linux/xdg-open |
| 2 | single-instance lock | FAIL | Different app paths in dev mode |
| 3 | BrowserWindow + will-navigate | FAIL | Chromium truncates custom scheme URLs |
| 4 | webRequest.onBeforeRedirect | FAIL | Doesn't fire for JS navigations |
| 5 | registerSchemesAsPrivileged (standard:true) | FAIL | URL validation errors |
| 6 | registerSchemesAsPrivileged (standard:false) | FAIL | Vite bundles code too late |
| 7 | Vite plugin banner injection | FAIL | generateBundle doesn't fire in dev mode |
| 8 | **onHeadersReceived + dedicated session** | **PASS** | Reads HTTP Location header directly |

## Automated Testing

### Test Infrastructure

Tests are located in `apps/desktop/` and `/tmp/pw-test/`:

| Test | Type | What it tests |
|------|------|---------------|
| `test-oauth-redirect.mjs` | Electron | JS navigation to custom scheme URLs |
| `test-302-redirect.mjs` | Electron | Server 302 redirect to custom scheme URLs |
| `test-e2e-electron.mjs` | Electron | Full OAuth flow (login + authorize + token) |
| `/tmp/pw-test/test-e2e-oauth.mjs` | Playwright | Full OAuth flow via headless browser |
| `/tmp/pw-test/test-oauth-spa-redirect.mjs` | Playwright | SPA redirect behavior investigation |
| `/tmp/pw-test/test-oauth-button.mjs` | Playwright | Post-login page HTML inspection |
| `/tmp/pw-test/test-oauth-api.mjs` | Playwright | OAuth endpoint behavior with session |

### Running Tests

```bash
# Electron E2E test (requires no app running)
ELECTRON_DISABLE_SANDBOX=1 npx electron test-e2e-electron.mjs

# Playwright tests (in /tmp/pw-test/)
cd /tmp/pw-test && node test-e2e-oauth.mjs

# Electron redirect interception test
ELECTRON_DISABLE_SANDBOX=1 npx electron test-302-redirect.mjs
```

### Key Testing Insights

1. **JS navigation vs 302 redirect**: Different Electron events fire for each:
   - JS (`location.href = "amical://..."`) → `will-navigate`
   - Server 302 → `will-redirect`, `webRequest.onBeforeRedirect`, `webRequest.onHeadersReceived`

2. **Custom scheme URL truncation**: Chromium truncates `amical://oauth/callback?code=XXX` to `amical://` in most events. Only `webRequest.onHeadersReceived` (reading the raw HTTP `Location` header) preserves the full URL.

3. **React form automation**: In Electron BrowserWindows, use `webContents.insertText()` instead of `input.value = ` for React-managed inputs.

4. **Session isolation**: Using `session.fromPartition("auth-oauth")` prevents webRequest handler conflicts between the auth window and the main app.

5. **Playwright for investigation**: Playwright's CDP integration (`newCDPSession`) can capture custom scheme requests that regular page events miss. This was critical for discovering the actual OAuth flow.

## Linux Development Setup

### Prerequisites

```bash
# Node.js 24 via fnm
curl -fsSL https://fnm.vercel.app/install | bash
source ~/.bashrc
fnm install 24
fnm use 24
corepack enable
corepack prepare pnpm@10.15.0 --activate
```

### First Run

```bash
cd /_O/amical
pnpm install --ignore-scripts
node node_modules/electron/install.js

# Create .env (see Environment Configuration above)
cp apps/desktop/.env.example apps/desktop/.env
# Edit .env with correct values

cd apps/desktop
ELECTRON_DISABLE_SANDBOX=1 pnpm start
```

### Known Linux Issues

| Issue | Workaround |
|-------|-----------|
| Chrome sandbox error | `ELECTRON_DISABLE_SANDBOX=1` |
| IBUS-WARNING surrounding-text | Harmless, ignore |
| `coreml` execution provider not found | Harmless, ONNX runtime falls back |
| `onnxruntime-node` postinstall failure | Use `pnpm install --ignore-scripts` |
| `whisper.cpp` CMake build failure | Expected in dev (whisper not needed for Cloud) |
| `build:native-helper` echo error | Fixed: replaced with inline Node.js script |
| Window not movable | Fixed: use native frame on Linux |
| `getMediaAccessStatus` crash | Fixed: guard with `process.platform === "darwin"` |
| ShortcutManager init crash | Fixed: skip when NativeBridge unavailable |
