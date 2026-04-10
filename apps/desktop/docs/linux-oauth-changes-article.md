# OAuth Authentication Pitfalls When Porting an Electron App to Linux --- Chromium's Custom Scheme Truncation Issue and Workarounds

## Introduction

I was porting an Electron desktop app to Linux. OAuth authentication that worked flawlessly on macOS and Windows simply refused to work on Linux. After investigation, I encountered a chain of issues rooted in Chromium's custom scheme handling --- problems that are poorly documented and difficult to find information about.

In this article, I share four problems I encountered and their solutions, including actual code. I hope this helps others facing similar situations.

---

## Background --- Differences from macOS/Windows

The app (Amical) uses OAuth2 PKCE authentication. On macOS and Windows, it uses the OS's deep link mechanism to receive callbacks.

```
1. App opens the authorize URL in an external browser
2. User logs in via the browser
3. Server redirects to amical://oauth/callback?code=xxx
4. OS handles the deep link and passes the URL to the app
5. App exchanges the code for a token
```

On macOS, the URL is received via `app.on("open-url")`, and on Windows, via the `second-instance` event with single instance lock. Straightforward.

**However, this does not work on Linux.**

Linux does have a custom scheme handler registration mechanism (`.desktop` file with `MimeType=x-scheme-handler/amical`), but the behavior of passing URLs from an external browser to the app is unreliable and highly environment-dependent. It is particularly unreliable in AppImage and sandbox environments.

Therefore, for Linux, I changed the approach to use a BrowserWindow to complete the entire OAuth flow within the app. This is where the problems began.

---

## Problem 1: Choosing Between will-redirect and will-navigate

### The OAuth Flow

In the Linux implementation, a BrowserWindow opens the login page, and after authentication completes, it navigates to the authorize endpoint. The first challenge was how to catch the server-side 302 redirect.

```
User Action                      Event
─────────────────────────────────────────────
1. Display login page             loadURL()
2. Enter email/password           (user action)
3. Login complete → navigate      did-navigate-in-page or did-navigate
   to root
4. Navigate to authorize          loadURL()
   endpoint
5. Server returns 302 to          will-redirect ← catch here
   callback
```

### The Login Completion Detection Trap

Detecting "login complete" in step 3 was tricky. When login completes on the login page (login.amical.ai/auth/sign-in), it navigates to the root URL (login.amical.ai/). However, **whether this navigation is an SPA in-page navigation (`did-navigate-in-page`) or a full navigation (`did-navigate`) depends on the server-side session state.**

On the first login, it fires `did-navigate-in-page`; on a quick re-login shortly after, it fires `did-navigate`.

The solution was to listen for both events:

```typescript
const onLoginComplete = (_event: unknown, url: string) => {
  if (
    !authorizeAttempted &&
    (url === "https://login.amical.ai/" ||
      url === "https://login.amical.ai")
  ) {
    authorizeAttempted = true;
    logger.main.info("Login complete, navigating to authorize endpoint");
    this.authWindow?.loadURL(authorizeUrl);
  }
};
this.authWindow.webContents.on("did-navigate-in-page", onLoginComplete);
this.authWindow.webContents.on("did-navigate", onLoginComplete);
```

The `authorizeAttempted` flag prevents double execution.

### Catching the Callback

The redirect from the authorize endpoint is caught with `will-redirect`. The reason for using `will-redirect` rather than `will-navigate` is that this is a redirect triggered by a 302 response from the server:

```typescript
this.authWindow.webContents.on("will-redirect", (event, url) => {
  if (url.startsWith(redirectUri)) {
    event.preventDefault();
    logger.main.info("OAuth callback captured via will-redirect:", url);
    this.handleDeepLinkFromWindow(url);
  }
});
```

When using an HTTPS callback URL (e.g., `https://core.amical.ai/auth/callback`) as the redirectUri, `will-redirect` provides the complete URL, and everything works fine up to this point.

---

## Problem 2: Chromium's Custom Scheme URL Truncation

This is the core issue.

The problem occurs when using the custom scheme `amical://oauth/callback` as the redirectUri.

### Symptoms

When the authorize endpoint returns a 302 redirect to a custom scheme:

```
HTTP/1.1 302 Found
Location: amical://oauth/callback?code=AUTH_CODE&state=STATE
```

When received via `will-navigate`, **the URL is truncated to just `amical://`.** The path (`/oauth/callback`) and query parameters (`?code=...&state=...`) are all stripped.

```typescript
// URL received in will-navigate
"amical://"  // ← no code or state!
```

Registering the custom scheme with `protocol.handle` did not help either.

### Cause

Chromium applies URL canonicalization to URLs with non-standard schemes (anything other than `http`/`https`/`file`, etc.). During this canonicalization process, URLs with schemes that Chromium does not recognize are truncated to just the scheme portion.

This is part of Chromium's security mechanism, based on the design philosophy of not guaranteeing URL structure (authority, path, query) for unknown schemes.

### Solution: registerSchemesAsPrivileged

Register the custom scheme as a "privileged scheme" **early** in `main.ts` (before `app.ready`):

```typescript
import { app, protocol } from "electron";

// Must be called before app.ready
protocol.registerSchemesAsPrivileged([
  { scheme: "amical", privileges: { standard: true, secure: true } },
]);
```

By specifying `standard: true`, Chromium treats this scheme as having a standard URL structure, preserving the path and query parameters. `secure: true` makes the scheme operate in a security context equivalent to HTTPS.

**Important: This call must be made before the `app.ready` event.** Since scheme information is finalized during Chromium initialization, registering after initialization has no effect.

In the actual code, it is placed immediately after the imports:

```typescript
// main.ts top
import dotenv from "dotenv";
dotenv.config();

import { app, ipcMain, protocol } from "electron";
import { logger } from "./logger";

// Register amical:// as a standard scheme so Chromium preserves the full URL
// (path, query params) in navigation events and protocol handlers.
// Must be called before app.ready.
protocol.registerSchemesAsPrivileged([
  { scheme: "amical", privileges: { standard: true, secure: true } },
]);
```

---

## Problem 3: Process Spawning from Custom Scheme Navigation

After solving Problem 2, `will-navigate` could now receive the full URL... but another problem appeared.

### Symptoms

When a navigation to `amical://oauth/callback?code=...` occurs inside the BrowserWindow, **the OS attempts to pass this URL to the system's protocol handler, launching another instance of the app.** The single instance lock causes the second process to exit immediately, but it pollutes the logs and, depending on timing, can interrupt the authentication flow.

### Solution: In-process Handling with session.protocol.handle

Register a protocol handler on the BrowserWindow's session to handle custom scheme navigation in-process:

```typescript
// Register handler on the authWindow's session
this.authWindow.webContents.session.protocol.handle("amical", (request) => {
  const fullUrl = request.url;
  logger.main.info("OAuth callback captured via protocol handler:", fullUrl);
  this.handleDeepLinkFromWindow(fullUrl);
  return new Response("", { status: 200 });
});
```

The key point is using `session.protocol.handle` (session-scoped) rather than `protocol.handle` (global). This ensures:

- The handler is active only within the authentication BrowserWindow
- The main window and other WebContents are not affected
- The navigation is not passed to the OS protocol handler

---

## Problem 4: Server-Side Behavior Changes

During repeated testing, I encountered situations where "it worked just a moment ago but doesn't work now."

### Symptoms

When rapidly repeating login/logout cycles, the authorize endpoint's behavior changes:

- **First login**: authorize endpoint -> 302 -> HTTPS callback URL
- **Quick re-login**: authorize endpoint -> 302 -> `amical://oauth/callback?code=...` (direct redirect to custom scheme)

The server appeared to dynamically change the redirect target based on session state.

### Workaround

I made the implementation handle **both** HTTPS callbacks and custom scheme callbacks. `will-redirect` catches HTTPS callbacks, and `session.protocol.handle` catches custom scheme callbacks. Regardless of which one arrives, the same `handleDeepLinkFromWindow` method processes it:

```typescript
// HTTPS callback: caught via will-redirect
this.authWindow.webContents.on("will-redirect", (event, url) => {
  if (url.startsWith(redirectUri)) {
    event.preventDefault();
    this.handleDeepLinkFromWindow(url);
  }
});

// Custom scheme callback: caught via session protocol handler
this.authWindow.webContents.session.protocol.handle("amical", (request) => {
  const fullUrl = request.url;
  this.handleDeepLinkFromWindow(fullUrl);
  return new Response("", { status: 200 });
});
```

The callback URL parsing side also handles both schemes:

```typescript
private handleDeepLinkFromWindow(url: string): void {
  const parsedUrl = new URL(url);
  const redirectUri = this.activeRedirectUri || this.config.redirectUri;

  // Match both amical://oauth/callback and HTTPS redirect URI
  const isAmicalScheme =
    parsedUrl.host === "oauth" && parsedUrl.pathname === "/callback";
  const isHttpsRedirect = url.startsWith(redirectUri);

  if (isAmicalScheme || isHttpsRedirect) {
    const code = parsedUrl.searchParams.get("code");
    const state = parsedUrl.searchParams.get("state");
    if (code) {
      this.handleAuthCallback(code, state);
    }
  }
}
```

---

## Final Implementation

Here is a summary of the overall structure.

### main.ts (at startup)

```typescript
import { app, protocol } from "electron";

// Register custom scheme before Chromium initialization (required)
protocol.registerSchemesAsPrivileged([
  { scheme: "amical", privileges: { standard: true, secure: true } },
]);

// ... after app.ready ...

// macOS/Windows: register OS deep link handler
app.setAsDefaultProtocolClient("amical");

// macOS: receive callback via open-url event
app.on("open-url", (event, url) => {
  event.preventDefault();
  appManager.handleDeepLink(url);
});
```

### auth-service.ts (Linux OAuth flow)

```typescript
async login(): Promise<void> {
  // Generate PKCE parameters
  const { verifier, challenge } = this.generatePKCE();
  const state = this.generateState();
  this.pendingAuth = { state, codeVerifier: verifier, codeChallenge: challenge };

  if (process.platform === "linux") {
    // Linux: run entire flow in BrowserWindow
    this.openAuthWindow(loginUrl, authorizeUrl);
  } else {
    // macOS/Windows: external browser → deep link
    await shell.openExternal(authorizeUrl);
  }
}
```

The `openAuthWindow` in the Linux branch contains all the workarounds for the four problems described above.

### Platform Branching Design Philosophy

The `process.platform === "linux"` branch exists only in one place: the `login()` method. Callback handling (`handleDeepLinkFromWindow`) and token exchange (`exchangeCodeForToken`) use platform-agnostic code. By minimizing branching, maintainability is preserved.

---

## E2E Test Automation

OAuth authentication flows are tedious to test manually. There are many steps: browser interaction, redirects, token exchange.

This project attempted to automate E2E testing using Claude Code + electron-test-mcp (an MCP tool for Electron). MCP tools allow programmatic control of the Electron app from Claude Code (clicking, text input, screenshot capture, etc.).

Test flow:

1. `mcp__electron-test__launch` to launch the app
2. `mcp__electron-test__click` to click the login button
3. Enter email/password in the authentication window
4. `mcp__electron-test__screenshot` to verify the screen
5. Validate the state after redirect

However, there are remaining challenges with event detection, such as cases where `will-redirect` does not fire on the second invocation. The behavior of Electron's navigation events depends heavily on WebContents state, and further investigation is needed to stabilize tests.

---

## Summary

Here is a summary of the problems encountered and their solutions when implementing OAuth authentication for Linux in an Electron app:

| Problem | Cause | Solution |
|------|------|------|
| Login completion detection | SPA navigation vs. full navigation changes based on server state | Listen for both `did-navigate-in-page` and `did-navigate` |
| URL truncation | Chromium's URL canonicalization for non-standard schemes | Specify `standard: true` in `protocol.registerSchemesAsPrivileged` |
| Process spawning | Custom scheme navigation passed to OS handler | In-process handling with `session.protocol.handle` |
| Redirect target changes | Server-side session state dependency | Support both HTTPS and custom scheme callbacks |

### Lessons Learned

1. **Call `registerSchemesAsPrivileged` before `app.ready`.** Without knowing this, you will be stuck forever on the custom scheme URL truncation issue. While it is documented in Electron's official documentation, concrete examples in the OAuth context are rare.

2. **Electron has many navigation events.** `will-navigate`, `did-navigate`, `will-redirect`, `did-redirect`, `did-navigate-in-page`... You need to choose the right event for your use case. In particular, server-side 302 redirects fire `will-redirect`, not `will-navigate`.

3. **Server-side behavior can change too.** Some problems cannot be diagnosed by looking only at the client side. The same authorize endpoint may change its redirect target depending on session state.

4. **Keep platform branching to a minimum.** More branches mean higher testing costs. The Linux-specific branch is consolidated into a single location within `login()`, and downstream processing is shared.

I hope this serves as a useful reference for anyone implementing OAuth authentication in an Electron app on Linux.
