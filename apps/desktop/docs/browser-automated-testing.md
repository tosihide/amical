# Browser Automated Testing with Playwright

## Overview

This document describes how to use Playwright for automated browser testing in the Amical desktop app, particularly for OAuth authentication flows that involve web-based login pages.

## Setup

```bash
# Install Playwright (in a separate directory to avoid pnpm workspace issues)
mkdir -p /tmp/pw-test && cd /tmp/pw-test
npm init -y
npm install playwright
npx playwright install chromium
```

## Why Playwright for OAuth Testing

OAuth flows involve:
1. Web-based login pages (SPAs) that require browser interaction
2. Server-side redirects (302) to custom protocol URLs
3. Cookie-based session management between login and authorization

Manual testing of these flows is slow and error-prone. Playwright can:
- Automate form filling and submission
- Capture network requests/responses at the CDP level
- Intercept custom scheme redirects (`amical://`)
- Execute the full flow in seconds, headlessly

## Key Patterns

### 1. Monitoring Network Activity

```javascript
// Capture all requests
page.on("request", (req) => {
  console.log(`[REQ] ${req.method()} ${req.url()}`);
});

// Capture redirects
page.on("response", (res) => {
  const status = res.status();
  if (status >= 300 && status < 400) {
    const location = res.headers()["location"];
    console.log(`[REDIRECT ${status}] -> ${location}`);
  }
});
```

### 2. CDP-Level Monitoring (catches custom schemes)

```javascript
const client = await page.context().newCDPSession(page);
await client.send("Network.enable");

client.on("Network.requestWillBeSent", (params) => {
  // This captures amical:// URLs that regular page events miss
  console.log(`[CDP] ${params.request.url}`);
});
```

### 3. Investigating SPA Behavior

```javascript
// After login, inspect what the SPA renders
const elements = await page.evaluate(() => {
  const results = [];
  document.querySelectorAll("a").forEach((a) => {
    results.push({ href: a.href, text: a.textContent?.trim() });
  });
  return results;
});
```

### 4. Full OAuth E2E Test

See `test-e2e-oauth.mjs` for a complete example that:
1. Generates proper PKCE parameters
2. Logs in via the SPA
3. Navigates to the authorize endpoint with session cookies
4. Captures the authorization code from the redirect
5. Exchanges the code for tokens

## Discovered Architecture

Through automated testing, we discovered the actual OAuth flow:

```
Login Phase (SPA):
  POST /api/auth/sign-in/email  →  Session cookie set

Authorization Phase (Server):
  GET /api/auth/oauth2/authorize?...  →  302 to amical://oauth/callback?code=XXX

Token Exchange:
  POST /api/auth/oauth2/token  →  { access_token, id_token, refresh_token }
```

Key finding: The SPA login page (`login.amical.ai/auth/sign-in`) does NOT redirect to the OAuth callback directly. Instead, it:
1. Authenticates the user and sets a session cookie
2. Shows an "Open Amical" page with `<a href="amical://">` (no code/state!)
3. The actual authorization code flow requires a separate request to `core.amical.ai/api/auth/oauth2/authorize`

## Electron Integration

On Linux, the BrowserWindow-based flow:
1. Opens login page in BrowserWindow with dedicated session partition
2. After login (detected via `did-navigate-in-page` to root URL), navigates to authorize endpoint
3. Server returns 302 → `amical://oauth/callback?code=...&state=...`
4. `webRequest.onHeadersReceived` reads the `Location` header directly from the HTTP response
5. Code is extracted and exchanged for tokens

### Critical: How to intercept custom scheme redirects

| Method | JS navigation | Server 302 | Preserves full URL? |
|---|---|---|---|
| `will-navigate` | YES | NO | Only with `registerSchemesAsPrivileged` |
| `will-redirect` | NO | YES | Only with `registerSchemesAsPrivileged` |
| `webRequest.onBeforeRedirect` | NO | YES | YES (always) |
| **`webRequest.onHeadersReceived`** | NO | **YES** | **YES (always)** |

**Winner: `webRequest.onHeadersReceived`** - reads the raw HTTP `Location` header before Chromium processes the redirect. No `registerSchemesAsPrivileged` needed.

### Session isolation

Using a dedicated session partition is critical:
```javascript
const authSession = session.fromPartition("auth-oauth");
new BrowserWindow({ webPreferences: { partition: "auth-oauth" } });
authSession.webRequest.onHeadersReceived((details, callback) => { ... });
```

Without this, the main app's session may have conflicting webRequest handlers that prevent `onHeadersReceived` from firing.

### registerSchemesAsPrivileged - NOT recommended

While `registerSchemesAsPrivileged` can make `will-navigate`/`will-redirect` preserve full URLs:
- `standard: true` causes URL validation errors in SPAs
- `standard: false` works in standalone scripts but fails when bundled by Vite (entry-point code runs at end of bundle)
- The `webRequest.onHeadersReceived` approach is simpler and more reliable

### React form automation in Electron

For React-based SPAs, use `webContents.insertText()` instead of setting `value` directly:
```javascript
// Wrong: React doesn't detect the change
await webContents.executeJavaScript(`input.value = "text"`);

// Correct: insertText triggers React's synthetic events
await webContents.executeJavaScript(`input.focus()`);
webContents.insertText("text");
```

## Test Files

- `test-oauth-redirect.mjs` - Tests which Electron events capture JS-initiated custom scheme redirects
- `test-302-redirect.mjs` - Tests which Electron events capture server 302 redirects to custom schemes
- `test-e2e-electron.mjs` - Full E2E OAuth flow test inside Electron BrowserWindow (login + authorize + token exchange)

### Playwright-based tests (in /tmp/pw-test/)

- `test-oauth-spa-redirect.mjs` - Investigates SPA redirect behavior and network activity
- `test-oauth-button.mjs` - Inspects the SPA's post-login page HTML elements
- `test-oauth-api.mjs` - Tests OAuth authorize and token endpoints with session cookies
- `test-e2e-oauth.mjs` - Full E2E OAuth flow test with PKCE via Playwright
