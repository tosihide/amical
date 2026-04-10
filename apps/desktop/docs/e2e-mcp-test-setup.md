# Electron E2E Testing with electron-test-mcp (Linux)

## Overview

### What is electron-test-mcp?

`electron-test-mcp` is an MCP (Model Context Protocol) server that wraps Playwright's Electron support. Claude Code connects as an MCP client, enabling tool-based interactions such as launching an Electron app, taking screenshots, manipulating the DOM, and executing JavaScript in the main process.

Unlike traditional E2E testing frameworks (Cypress, standalone Playwright, etc.) where test code must be written as scripts in advance, electron-test-mcp allows you to operate and verify the app interactively during a conversation with Claude Code. This makes it possible to debug complex screen transitions, such as OAuth flows, in an interactive manner.

### How It Works

```
Claude Code (MCP Client)
    ↓ MCP tool call (JSON-RPC)
electron-test-mcp (MCP Server)
    ↓ Playwright Electron API
Electron App (Amical Desktop)
```

When Claude Code calls tools like `mcp__electron-test__launch()`, electron-test-mcp launches and controls the Electron app via Playwright.

### Available MCP Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `launch` | Launch app | Specify `appPath`, `env`, `executablePath` |
| `close` | Close app | |
| `screenshot` | Capture screenshot | Returns a Base64-encoded image |
| `snapshot` | Get accessibility tree | Useful for understanding screen structure |
| `click` | Click an element | Uses Playwright selectors |
| `fill` | Input text | |
| `press` | Press a key | |
| `hover` | Hover | |
| `evaluate` | Execute JS in renderer process | Targets the focused window |
| `evaluateMain` | Execute JS in main process | Uses `(electron) => ...` format |
| `getText` | Get text content | |
| `getAttribute` | Get attribute value | |
| `isVisible` | Check visibility | |
| `wait` | Wait | Wait for a selector to appear, etc. |
| `count` | Count elements | |
| `selectOption` | Interact with select boxes | |
| `drag` | Drag operation | |
| `type` | Keyboard input (character by character) | |
| `connect` | Connect to an existing app | |
| `disconnect` | Disconnect | |

---

## Installation

### 1. Claude Code MCP Configuration

Add the following to `mcpServers` in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "electron-test": {
      "command": "npx",
      "args": ["electron-test-mcp"]
    }
  }
}
```

On first run, the package is automatically installed under `~/.npm/_npx/`.

### 2. Linux Environment Patch (Required)

#### Why the Patch Is Needed

`electron-test-mcp` v0.1.0 is designed for macOS by default and does not work on Linux (Ubuntu) due to the following issues:

1. **`executablePath` not specified** -- Launch fails in environments where the `electron` command is not on the PATH
2. **`--no-sandbox` not specified** -- Chromium sandbox error for non-root users
3. **`--ozone-platform=x11` not specified** -- Display issues may occur in Wayland/X11 environments
4. **`ELECTRON_DISABLE_SANDBOX` not set** -- Sandbox-related crashes

#### Locating the File to Patch

```bash
find ~/.npm/_npx -path "*/electron-test-mcp/dist/index.js" | head -1
```

Example output: `~/.npm/_npx/abc123def/node_modules/electron-test-mcp/dist/index.js`

#### Patch Details

Modify the Electron launch section (the `_electron.launch` call) in the `launch` case.

**Before:**
```javascript
const appPath = args?.appPath || "./out/main/index.js";
const env = args?.env || {};
electronApp = await _electron.launch({
    args: [appPath],
    env: { ...process.env, ...env, TEST_MODE: "true" },
});
```

**After:**
```javascript
const appPath = args?.appPath || "./out/main/index.js";
const env = args?.env || {};
const execPath = args?.executablePath || process.env.ELECTRON_PATH || "/_O/amical/node_modules/electron/dist/electron";
electronApp = await _electron.launch({
    executablePath: execPath,
    args: ["--no-sandbox", "--ozone-platform=x11", appPath],
    env: { ...process.env, ...env, TEST_MODE: "true", ELECTRON_DISABLE_SANDBOX: "1" },
});
```

Replace `/_O/amical` with the actual project root path.

#### Patch Application Script

```bash
# パッチファイルの場所を特定
MCP_INDEX=$(find ~/.npm/_npx -path "*/electron-test-mcp/dist/index.js" | head -1)
echo "Patching: $MCP_INDEX"

# バックアップ
cp "$MCP_INDEX" "$MCP_INDEX.bak"

# sed で置換（プロジェクトパスは適宜変更）
sed -i 's|electronApp = await _electron.launch({|const execPath = args?.executablePath || process.env.ELECTRON_PATH || "/_O/amical/node_modules/electron/dist/electron";\n                electronApp = await _electron.launch({\n                    executablePath: execPath,|' "$MCP_INDEX"
sed -i 's|args: \[appPath\],|args: ["--no-sandbox", "--ozone-platform=x11", appPath],|' "$MCP_INDEX"
sed -i 's|TEST_MODE: "true"|TEST_MODE: "true", ELECTRON_DISABLE_SANDBOX: "1"|' "$MCP_INDEX"
```

After applying the patch, restart Claude Code (`/quit` then relaunch) to reload the MCP server.

> **Note**: Running `npm cache clean` or clearing the cache will remove the patch. Package updates will also overwrite it.

---

## Prerequisites

### 1. Full App Build

The MCP `launch` mode does not start a Vite dev server, so a full build is required beforehand. `pnpm start` (dev mode) cannot be used.

```bash
cd /_O/amical/apps/desktop
pnpm package
```

This generates:
- `.vite/build/main.js` -- Main process entry point
- `.vite/renderer/` -- Renderer-side HTML/JS/CSS

### 2. Symlink for DB Migration

The built `main.js` looks for the migration folder via a relative path from `process.cwd()`. When running from the project root:

```bash
ln -s /_O/amical/apps/desktop/src /_O/amical/src
```

Without this symlink, the app will crash on startup with a DB migration error.

### 3. Environment Variables File (.env)

Set the following in `/_O/amical/apps/desktop/.env`:

```env
TEST_EMAIL=your-test-email@example.com
TEST_PASSWORD=your-test-password
```

These are used for the OAuth E2E test. This file is loaded by `dotenv.config()` at the top of `src/main/main.ts`.

---

## Test Procedure (Detailed)

### Step 0: Clean Up Test Environment (Preparation)

Before each test run, delete data from the previous run to start fresh:

```bash
# DB ファイルの削除（全候補パスを網羅）
rm -f ~/.config/Electron/amical.db \
      ~/.config/Amical/amical.db \
      /_O/amical/apps/desktop/amical.db \
      /_O/amical/amical.db

# auth セッションのクリア（必要に応じて）
rm -rf ~/.config/Electron/Partitions/auth-oauth
```

> **Important**: Dev builds (`pnpm start` or via MCP) store data in `~/.config/Electron/`, while packaged builds use `~/.config/Amical/`. See the "Notes" section below for details.

### Step 1: Launch the App

```
mcp__electron-test__launch(
  appPath: "/_O/amical/apps/desktop/.vite/build/main.js",
  env: {"ELECTRON_DISABLE_SANDBOX": "1"}
)
```

On success, the Amical onboarding screen (Step 1: Feature Selection) is displayed.

After launch, verify the screen state with `screenshot` or `snapshot`:

```
mcp__electron-test__screenshot()
mcp__electron-test__snapshot()
```

### Step 2: Onboarding -- Step 1 (Feature Selection)

Click the "Contextual Dictation" card:

```
mcp__electron-test__click(
  selector: "text=Contextual Dictation"
)
```

Click the "Continue" button to proceed:

```
mcp__electron-test__click(
  selector: "text=Continue"
)
```

### Step 3: Onboarding -- Step 2 (Permissions)

This is the permissions screen. Click "Continue":

```
mcp__electron-test__click(
  selector: "text=Continue"
)
```

### Step 4: Onboarding -- Step 3 (Discovery)

Select an integration (e.g., GitHub) then click Continue:

```
mcp__electron-test__click(
  selector: "text=GitHub"
)
mcp__electron-test__click(
  selector: "text=Continue"
)
```

### Step 5: Onboarding -- Step 4 (Model Selection)

Here, select the "Amical Cloud" card to proceed to OAuth sign-in.

**Important**: The Amical Cloud card cannot be clicked using standard Playwright selectors. You need to invoke the React internal event handler directly.

```
mcp__electron-test__evaluate(
  script: "(() => { const allEls = document.querySelectorAll('*'); for (const el of allEls) { const pk = Object.keys(el).find(k => k.startsWith('__reactProps')); if (pk && typeof el[pk]?.onClick === 'function' && el.textContent?.includes('Amical Cloud')) { el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true})); break; } } })()"
)
```

> **Why the React onClick workaround is needed**: The click event for the Amical Cloud card is managed via React's synthetic events (SyntheticEvent). Playwright's `click` fires native DOM events, but in React 18, events are delegated at the `document` level, and Playwright's click may not reach the React handler. Calling `onClick` directly from `__reactProps` ensures reliable behavior.

Wait 500ms, then click the "Sign in" button in the modal:

```
mcp__electron-test__wait(
  timeout: 500
)
mcp__electron-test__evaluate(
  script: "(() => { const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Sign in'); if (btn) btn.click(); return btn ? 'clicked' : 'not found'; })()"
)
```

### Step 6: OAuth Sign-In (Auth Window Operations)

After clicking "Sign in", on Linux a `BrowserWindow` opens to `login.amical.ai` (on macOS/Windows, the default browser opens instead).

#### 6a. Verify Auth Window Appearance

```
mcp__electron-test__evaluateMain(
  script: "(electron) => electron.BrowserWindow.getAllWindows().map(w => ({id: w.id, title: w.getTitle(), url: w.webContents.getURL()}))"
)
```

Expected result: Two windows (main window + auth window). The auth window URL should look like `https://login.amical.ai/auth/sign-in?...`.

#### 6b. Fill and Submit the Login Form

Use `nativeSetter` to set form values and submit within the auth window. In React-managed forms, simply setting `input.value = '...'` does not update the state. Instead, call the `HTMLInputElement.prototype.value` setter directly and dispatch an `input` event.

```
mcp__electron-test__evaluateMain(
  script: "(electron) => { const authWin = electron.BrowserWindow.getAllWindows().find(w => w.getTitle().includes('Login') || w.webContents.getURL().includes('login.amical.ai')); if (!authWin) return 'auth window not found'; return authWin.webContents.executeJavaScript(`const emailInput = document.querySelector('input[type=\"email\"]'); const passInput = document.querySelector('input[type=\"password\"]'); const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; nativeSetter.call(emailInput, '${process.env.TEST_EMAIL}'); emailInput.dispatchEvent(new Event('input', {bubbles: true})); nativeSetter.call(passInput, '${process.env.TEST_PASSWORD}'); passInput.dispatchEvent(new Event('input', {bubbles: true})); setTimeout(() => document.querySelector('button[type=\"submit\"]').click(), 300); 'submitted'`); }"
)
```

> **Note**: `process.env.TEST_EMAIL` and `process.env.TEST_PASSWORD` are read from the main process environment variables. They must be set in the `.env` file.

#### 6c. OAuth Callback Handling

The flow after successful login (based on the auth-service.ts implementation):

1. User submits the form -> `login.amical.ai` processes the login
2. Login succeeds -> Page navigates to `https://login.amical.ai/` (root)
3. Detected via `did-navigate` or `did-navigate-in-page` event
4. Automatically navigates to `authorizeUrl` (OAuth authorization endpoint)
5. Server responds with a `302` redirect to the `redirectUri`
6. `will-redirect` event captures the callback URL
7. Extracts `code` and `state` parameters for token exchange
8. Authentication succeeds -> Auth window closes -> `authenticated` event fires

### Step 7: Verify Results

Wait 5 seconds before checking:

```
mcp__electron-test__wait(
  timeout: 5000
)
```

#### 7a. Check Window State

```
mcp__electron-test__evaluateMain(
  script: "(electron) => electron.BrowserWindow.getAllWindows().map(w => ({id: w.id, title: w.getTitle(), url: w.webContents.getURL()}))"
)
```

- **Success**: Auth window is gone, only the main window remains. The setup screen shows Step 5 "Setup Complete!"
- **Failure**: Auth window is stuck at `https://login.amical.ai/` -> `did-navigate`/`did-navigate-in-page` may not have fired

#### 7b. Visual Verification via Screenshot

```
mcp__electron-test__screenshot()
```

#### 7c. Check Logs (Separate Terminal or Bash Tool)

```bash
grep -E "auth-diag|OAuth|Login complete|will-redirect|did-navigate" \
  ~/.config/Electron/logs/amical-dev.log | tail -30
```

Expected log sequence:
```
[auth-diag] did-navigate: https://login.amical.ai/auth/sign-in?...
[auth-diag] did-navigate-in-page: https://login.amical.ai/
Login complete, navigating to authorize endpoint
[auth-diag] will-redirect: https://login.amical.ai/oauth2/callback/amical-desktop?code=...&state=...
OAuth callback captured via will-redirect: https://login.amical.ai/oauth2/callback/amical-desktop?code=...
Handling auth callback
Token exchange successful
Authentication successful
```

#### 7d. Check Processes

```bash
ps aux | grep -i electron | grep -v grep
```

### Step 8: Clean Up

```
mcp__electron-test__close()
```

Then delete the DB in preparation for the next test:

```bash
rm -f ~/.config/Electron/amical.db \
      ~/.config/Amical/amical.db \
      /_O/amical/apps/desktop/amical.db \
      /_O/amical/amical.db
```

To fully reset the configuration directory:

```bash
# dev ビルド用
rm -rf ~/.config/Electron/

# パッケージビルド用
rm -rf ~/.config/Amical/
```

---

## Notes

### ~/.config/Electron vs ~/.config/Amical

Electron's `app.getPath("userData")` is determined based on the app name (the `name` field in `package.json` or the value set by `app.setName()`).

| Build Type | Data Location | Applicable Case |
|-----------|--------------|----------------|
| Dev build (`pnpm start`, MCP `launch`) | `~/.config/Electron/` | `app.isPackaged === false` |
| Packaged build (`.deb`/`.rpm` generated via `pnpm make`) | `~/.config/Amical/` | `app.isPackaged === true` |

**MCP tests use `~/.config/Electron/`.** Keep this in mind when deleting DBs or checking logs. Deleting both paths to be safe is recommended.

### 5-Minute Interval Rule (For Repeated Tests)

The server-side authorization behavior differs based on the time elapsed since the last login:

- **Retesting within a short period (5 minutes or less)**: The server may remember the session and skip the login screen, going directly to authorization. In this case, `did-navigate` may fire instead of `did-navigate-in-page`, or the flow may differ entirely
- **After 5 minutes or more**: The session expires and the full login flow runs

If you get different results when running tests consecutively, **wait at least 5 minutes** before retesting.

Alternatively, deleting the auth session partition forces the full login flow:

```bash
rm -rf ~/.config/Electron/Partitions/auth-oauth
```

### amical:// Protocol and Process Spawning Issue

`protocol.registerSchemesAsPrivileged()` is called at the top of `main.ts`:

```typescript
protocol.registerSchemesAsPrivileged([
  { scheme: "amical", privileges: { standard: true, secure: true } },
]);
```

Without this registration, the following issues occur during a `302` redirect to `amical://oauth/callback`:

1. Chromium treats the `amical://` scheme as an "external protocol" and delegates to the OS protocol handler
2. The OS attempts to launch a new Electron process (since it is registered via `app.setAsDefaultProtocolClient`)
3. A new process starts, but since it is separate from the original process, the callback never arrives

`registerSchemesAsPrivileged` registers `amical://` as a "standard scheme," allowing Chromium to preserve path and query parameters internally. However, on Linux, the current implementation uses the `will-redirect` + HTTPS redirect URI approach, which avoids the `amical://` issue entirely.

### React onClick Workaround

There is a known issue where standard Playwright `click` does not work on the Amical Cloud card. This is caused by React 18's event delegation (listeners are registered at the `document` root).

Workaround: Retrieve `onClick` from the `__reactProps$xxx` property and manually dispatch a `MouseEvent`:

```javascript
const allEls = document.querySelectorAll('*');
for (const el of allEls) {
  const pk = Object.keys(el).find(k => k.startsWith('__reactProps'));
  if (pk && typeof el[pk]?.onClick === 'function'
      && el.textContent?.includes('Amical Cloud')) {
    el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
    break;
  }
}
```

This workaround depends on `__reactProps`, a React internal implementation detail, and may break with future React version upgrades.

---

## Troubleshooting

### App Fails to Launch

| Symptom | Cause | Solution |
|---------|-------|----------|
| `Cannot find module` | App not built | Run `pnpm package` |
| `Running as root without --no-sandbox is not supported` | Sandbox error | Add `--no-sandbox` and `ELECTRON_DISABLE_SANDBOX=1` via the patch |
| `electron: command not found` | executablePath not set | Add `executablePath` via the patch |
| DB migration error | Symlink missing | `ln -s /_O/amical/apps/desktop/src /_O/amical/src` |
| Black screen | Renderer not built | Verify that `.vite/renderer/` was generated by `pnpm package` |

### OAuth Login Fails

| Symptom | Cause | Solution |
|---------|-------|----------|
| Auth window does not open | `login()` not called | Check Step 4 state via screenshot |
| Auth window stuck at `login.amical.ai` | `did-navigate`/`did-navigate-in-page` not firing | Check logs. Verify the 5-minute rule does not apply |
| `will-redirect` not firing | Redirect URI mismatch | Check `AUTH_REDIRECT_URI` in `.env` |
| `Token exchange failed` | PKCE verification failure or expired | Wait 5+ minutes and retry |
| `State mismatch` | State parameter mismatch | Delete DB and start over |
| `input[type="email"]` not found | Page not fully loaded | Use `wait` for 2-3 seconds before filling the form |
| `process.env.TEST_EMAIL` is undefined | `.env` not configured | Set test credentials in `apps/desktop/.env` |

### MCP Connection Issues

| Symptom | Cause | Solution |
|---------|-------|----------|
| `MCP tool not found` | MCP server not connected | Restart Claude Code. Check connection with `/mcp` |
| `electronApp is not defined` | Called another tool before `launch` | Run `launch` first |
| Patch not taking effect | npm cache cleared or package updated | Re-check with `find ~/.npm/_npx -path "*/electron-test-mcp/dist/index.js"` and reapply the patch |

### Behavior Changes on Second Test Run

Cause: Residual server-side sessions. Solutions:

1. Delete the auth session partition: `rm -rf ~/.config/Electron/Partitions/auth-oauth`
2. Wait at least 5 minutes between tests
3. Delete the DB to reset `pendingAuth` state

---

## Log File Locations and How to Check

### Log File Paths

| Build | Path |
|-------|------|
| Dev build (MCP test) | `~/.config/Electron/logs/amical-dev.log` |
| Packaged build | `~/.config/Amical/logs/amical.log` |

Log format: `[datetime] [level] [scope] message`

### Useful grep Patterns

```bash
# OAuth フロー全体の追跡
grep -E "OAuth|auth-diag|Login complete|will-redirect|did-navigate|handleAuthCallback|Token exchange|Authentication" \
  ~/.config/Electron/logs/amical-dev.log | tail -40

# エラーのみ
grep -i "error" ~/.config/Electron/logs/amical-dev.log | tail -20

# AuthService の初期化と設定確認
grep "AuthService initialized" ~/.config/Electron/logs/amical-dev.log

# リダイレクト URI の確認
grep "redirectUri\|redirect_uri\|OAuth callback" ~/.config/Electron/logs/amical-dev.log

# DB マイグレーション
grep -i "migration" ~/.config/Electron/logs/amical-dev.log

# メインプロセスのエラー
grep "\[main\].*error" ~/.config/Electron/logs/amical-dev.log | tail -10
```

### Maximum Log Size

Log files are rotated at a maximum of 10MB (`electron-log` setting). When running tests repeatedly, older logs may be deleted. Check important logs immediately after testing.

### Real-Time Log Monitoring

To monitor logs in real time during tests:

```bash
tail -f ~/.config/Electron/logs/amical-dev.log | grep --line-buffered -E "OAuth|auth-diag|Login|error"
```
