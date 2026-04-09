import { app, BrowserWindow, session } from "electron";
import { randomBytes, createHash } from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env from the same directory if env vars are not already set
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const lines = readFileSync(join(__dirname, ".env"), "utf-8").split("\n");
  for (const line of lines) {
    const match = line.match(/^\s*([\w]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
} catch {
  // .env not found, rely on environment variables
}

const CLIENT_ID = process.env.AUTH_CLIENT_ID || "5a0dc096e6174e5f9eec0403b2a69a24";
const REDIRECT_URI = process.env.AUTH_REDIRECT_URI || "amical://oauth/callback";
const AUTH_ENDPOINT = process.env.AUTHORIZATION_ENDPOINT || "https://core.amical.ai/api/auth/oauth2/authorize";
const TOKEN_ENDPOINT = process.env.AUTH_TOKEN_ENDPOINT || "https://core.amical.ai/api/auth/oauth2/token";
const LOGIN_URL = process.env.AUTH_LOGIN_URL || "https://login.amical.ai/auth/sign-in";
const EMAIL = process.env.TEST_EMAIL || "";
const PASSWORD = process.env.TEST_PASSWORD || "";

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

app.whenReady().then(async () => {
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

  console.log("=== E2E Test (dedicated session + onHeadersReceived) ===\n");

  const authSession = session.fromPartition("test-auth-oauth");

  const win = new BrowserWindow({
    width: 800, height: 700, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, partition: "test-auth-oauth" },
  });

  // Step 1: Login
  console.log("[STEP 1] Loading login page...");
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
    win.webContents.on("did-navigate-in-page", (ev, url) => {
      if (url === "https://login.amical.ai/" || url === "https://login.amical.ai") {
        loginDone = true; resolve();
      }
    });
    setTimeout(() => resolve(), 15000);
  });
  if (!loginDone) { console.log("[FAIL] Login failed"); app.quit(); return; }
  console.log("[STEP 1] Login complete!");
  await new Promise(r => setTimeout(r, 1000));

  // Step 2: Authorize with onHeadersReceived
  console.log("\n[STEP 2] Navigating to authorize endpoint...");

  const authResult = await new Promise((resolve) => {
    authSession.webRequest.onHeadersReceived((details, callback) => {
      const loc = details.responseHeaders?.["location"]?.[0] ||
                  details.responseHeaders?.["Location"]?.[0];
      if (loc && loc.startsWith("amical://")) {
        console.log("[STEP 2] Intercepted: " + loc);
        callback({ cancel: true });
        resolve(loc);
        return;
      }
      callback({});
    });
    win.loadURL(authorizeUrl);
    setTimeout(() => resolve(null), 10000);
  });

  if (!authResult) { console.log("[FAIL] No redirect"); app.quit(); return; }

  const cbUrl = new URL(authResult);
  const code = cbUrl.searchParams.get("code");
  console.log("[STEP 2] Code: " + code);
  console.log("[STEP 2] State match: " + (cbUrl.searchParams.get("state") === state));

  // Step 3: Token exchange
  console.log("\n[STEP 3] Token exchange...");
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code, client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI, code_verifier: verifier }),
  });
  console.log("[STEP 3] Status: " + res.status);
  if (res.ok) {
    const t = await res.json();
    console.log("[STEP 3] access_token: " + (t.access_token ? "OK" : "MISSING"));
    console.log("[STEP 3] id_token: " + (t.id_token ? "OK" : "MISSING"));
    console.log("[STEP 3] refresh_token: " + (t.refresh_token ? "OK" : "MISSING"));
    console.log("\n=== SUCCESS ===");
  } else {
    console.log("[STEP 3] Error: " + await res.text());
    console.log("\n=== FAIL ===");
  }
  app.quit();
});
