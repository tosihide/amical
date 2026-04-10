/**
 * E2E test for OAuth sign-in flow in Electron.
 *
 * Records ALL navigation events and tests which ones fire with the full
 * callback URL.  Runs the flow TWICE (with DB delete in between) to verify
 * that the chosen interception strategy works for both fresh and returning
 * sessions.
 *
 * Usage:
 *   ELECTRON_DISABLE_SANDBOX=1 npx electron --no-sandbox test-e2e-electron.mjs
 *
 * Reads credentials from .env (TEST_EMAIL, TEST_PASSWORD).
 */
import { app, BrowserWindow, session } from "electron";
import { randomBytes, createHash } from "crypto";
import { readFileSync, unlinkSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const lines = readFileSync(join(__dirname, ".env"), "utf-8").split("\n");
  for (const line of lines) {
    const match = line.match(/^\s*([\w]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
} catch { /* .env not found */ }

const CLIENT_ID = process.env.AUTH_CLIENT_ID || "5a0dc096e6174e5f9eec0403b2a69a24";
const REDIRECT_URI = process.env.AUTH_REDIRECT_URI || "https://login.amical.ai/oauth2/callback/amical-desktop";
const AUTH_ENDPOINT = process.env.AUTHORIZATION_ENDPOINT || "https://core.amical.ai/api/auth/oauth2/authorize";
const TOKEN_ENDPOINT = process.env.AUTH_TOKEN_ENDPOINT || "https://core.amical.ai/api/auth/oauth2/token";
const LOGIN_URL = process.env.AUTH_LOGIN_URL || "https://login.amical.ai/auth/sign-in";
const EMAIL = process.env.TEST_EMAIL || "";
const PASSWORD = process.env.TEST_PASSWORD || "";

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

const DB_PATHS = [
  join(process.env.HOME, ".config/Amical/amical.db"),
  join(process.env.HOME, ".config/Electron/amical.db"),
  join(__dirname, "amical.db"),
  join(__dirname, "../../amical.db"),  // project root
];

function deleteDb() {
  for (const p of DB_PATHS) {
    if (existsSync(p)) { unlinkSync(p); console.log(`  Deleted: ${p}`); }
  }
}

/**
 * Run one OAuth flow and record every navigation event.
 * Returns { events, code, tokenOk }
 */
async function runOAuthFlow(label) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${"=".repeat(60)}`);

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  const params = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code",
    scope: "openid profile email offline_access", state,
    code_challenge: challenge, code_challenge_method: "S256",
  });
  const authorizeUrl = AUTH_ENDPOINT + "?" + params.toString();
  const loginUrl = LOGIN_URL + "?" + params.toString();

  const win = new BrowserWindow({
    width: 800, height: 700, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  // === Step 1: Login ===
  console.log("\n[STEP 1] Loading login page...");
  await win.loadURL(loginUrl);
  await new Promise(r => setTimeout(r, 3000));

  await win.webContents.executeJavaScript(`document.querySelector('input[type="email"]').focus(); true;`);
  win.webContents.insertText(EMAIL);
  await new Promise(r => setTimeout(r, 300));
  await win.webContents.executeJavaScript(`document.querySelector('input[type="password"]').focus(); true;`);
  win.webContents.insertText(PASSWORD);
  await new Promise(r => setTimeout(r, 300));
  await win.webContents.executeJavaScript(`document.querySelector('button[type="submit"]').click(); true;`);

  let loginDone = false;
  await new Promise((resolve) => {
    win.webContents.on("did-navigate-in-page", (_ev, url) => {
      if (url === "https://login.amical.ai/" || url === "https://login.amical.ai") {
        loginDone = true; resolve();
      }
    });
    setTimeout(() => resolve(), 15000);
  });
  if (!loginDone) {
    console.log("[FAIL] Login did not complete within 15s");
    win.close();
    return { events: [], code: null, tokenOk: false };
  }
  console.log("[STEP 1] Login complete!");
  await new Promise(r => setTimeout(r, 1000));

  // === Step 2: Authorize — record ALL events ===
  console.log("\n[STEP 2] Navigating to authorize endpoint...");
  console.log("  authorize URL:", authorizeUrl.substring(0, 80) + "...");

  const events = [];
  let callbackUrl = null;
  let callbackHandler = null;

  const authResult = await new Promise((resolve) => {
    const MONITORED = [
      "will-navigate",
      "will-redirect",
      "did-navigate",
      "did-navigate-in-page",
      "did-redirect-navigation",
    ];

    for (const evt of MONITORED) {
      win.webContents.on(evt, (event, url) => {
        const ts = new Date().toISOString().substring(11, 23);
        console.log(`  [${ts}] ${evt}: ${url}`);
        events.push({ handler: evt, url, ts });

        if (!callbackUrl && url.startsWith(REDIRECT_URI)) {
          callbackUrl = url;
          callbackHandler = evt;
          event.preventDefault();
          console.log(`  >>> CALLBACK CAPTURED by ${evt}`);
          resolve(url);
        }
      });
    }

    win.loadURL(authorizeUrl);
    setTimeout(() => resolve(null), 15000);
  });

  // === Step 3: Results ===
  console.log("\n--- Event Summary ---");
  for (const e of events) {
    const marker = e.url.startsWith(REDIRECT_URI) ? " ***" : "";
    console.log(`  ${e.handler}: ${e.url.substring(0, 100)}${marker}`);
  }

  if (!authResult) {
    console.log("\n[FAIL] No callback captured within 15s");
    win.close();
    return { events, code: null, tokenOk: false };
  }

  let code = null;
  try {
    code = new URL(authResult).searchParams.get("code");
  } catch { /* ignore */ }

  console.log(`\n[RESULT] Captured by: ${callbackHandler}`);
  console.log(`[RESULT] Code: ${code ? code.substring(0, 8) + "..." : "MISSING"}`);

  // === Step 4: Token exchange ===
  let tokenOk = false;
  if (code) {
    console.log("\n[STEP 4] Token exchange...");
    try {
      const res = await fetch(TOKEN_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code", code, client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI, code_verifier: verifier,
        }),
      });
      console.log(`[STEP 4] HTTP ${res.status}`);
      if (res.ok) {
        const t = await res.json();
        tokenOk = !!(t.access_token && t.id_token);
        console.log(`[STEP 4] access_token: ${t.access_token ? "OK" : "MISSING"}`);
        console.log(`[STEP 4] id_token: ${t.id_token ? "OK" : "MISSING"}`);
        console.log(`[STEP 4] refresh_token: ${t.refresh_token ? "OK" : "MISSING"}`);
      } else {
        console.log(`[STEP 4] Error: ${await res.text()}`);
      }
    } catch (err) {
      console.log(`[STEP 4] Fetch error: ${err.message}`);
    }
  }

  win.close();
  return { events, code, tokenOk, callbackHandler };
}

// =============================================================
// Main — run twice
// =============================================================
app.whenReady().then(async () => {
  if (!EMAIL || !PASSWORD) {
    console.log("[FAIL] TEST_EMAIL and TEST_PASSWORD must be set");
    app.quit();
    return;
  }

  console.log("REDIRECT_URI:", REDIRECT_URI);

  // --- Run 1: Fresh session ---
  deleteDb();
  // Clear session cookies for clean state
  const defaultSession = session.defaultSession;
  await defaultSession.clearStorageData();
  const result1 = await runOAuthFlow("RUN 1: Fresh session (no prior login)");

  // --- Run 2: Returning session (cookies remain, DB deleted) ---
  console.log("\n\nPreparing for Run 2...");
  deleteDb();
  // Do NOT clear session — simulate returning user with existing browser session
  await new Promise(r => setTimeout(r, 2000));
  const result2 = await runOAuthFlow("RUN 2: Returning session (cookies remain, DB deleted)");

  // === Final Summary ===
  console.log(`\n${"=".repeat(60)}`);
  console.log("  FINAL SUMMARY");
  console.log(`${"=".repeat(60)}`);
  console.log(`Run 1: callback by [${result1.callbackHandler || "NONE"}], code=${result1.code ? "YES" : "NO"}, token=${result1.tokenOk ? "OK" : "FAIL"}`);
  console.log(`Run 2: callback by [${result2.callbackHandler || "NONE"}], code=${result2.code ? "YES" : "NO"}, token=${result2.tokenOk ? "OK" : "FAIL"}`);

  // Collect which events captured the callback URL across both runs
  const handlers1 = result1.events.filter(e => e.url.startsWith(REDIRECT_URI)).map(e => e.handler);
  const handlers2 = result2.events.filter(e => e.url.startsWith(REDIRECT_URI)).map(e => e.handler);
  console.log(`\nEvents with full callback URL:`);
  console.log(`  Run 1: ${handlers1.length ? handlers1.join(", ") : "NONE"}`);
  console.log(`  Run 2: ${handlers2.length ? handlers2.join(", ") : "NONE"}`);

  if (result1.tokenOk && result2.tokenOk) {
    console.log("\n=== ALL TESTS PASSED ===");
  } else {
    console.log("\n=== SOME TESTS FAILED ===");
  }

  app.quit();
});
