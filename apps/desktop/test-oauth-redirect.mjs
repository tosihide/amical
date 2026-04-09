/**
 * Test script to verify which method can intercept amical:// redirects
 * in an Electron BrowserWindow without URL truncation.
 *
 * Simulates what login.amical.ai does:
 *   1. Load an HTML page
 *   2. Page executes: window.location.href = "amical://oauth/callback?code=TESTCODE&state=TESTSTATE"
 *   3. Check if Electron can capture the full URL
 *
 * Usage: ELECTRON_DISABLE_SANDBOX=1 npx electron test-oauth-redirect.mjs
 */

import { app, BrowserWindow, protocol } from "electron";
import { createServer } from "http";

const EXPECTED_URL = "amical://oauth/callback?code=TESTCODE&state=TESTSTATE";

// --- Method 8: registerSchemesAsPrivileged with standard:false ---
// Must be called before app.whenReady()
protocol.registerSchemesAsPrivileged([
  {
    scheme: "amical",
    privileges: {
      standard: false,
      secure: false,
      supportFetchAPI: false,
      bypassCSP: true,
    },
  },
]);

const results = {};

function log(method, success, url) {
  if (results[method]) return; // only record first hit
  results[method] = { success, url };
  const icon = success ? "PASS" : "FAIL";
  console.log(`[${icon}] ${method}: ${url}`);
}

app.whenReady().then(async () => {
  // --- Method 6: protocol.handle ---
  let method6resolved = false;
  protocol.handle("amical", (request) => {
    if (!method6resolved) {
      method6resolved = true;
      const success = request.url === EXPECTED_URL;
      log("6-protocol-handle", success, request.url);
    }
    return new Response("ok", { status: 200 });
  });

  // Create a local HTTP server that serves the test page
  const server = createServer((req, res) => {
    // Simulate what login.amical.ai does after authentication:
    // Multiple redirect methods to test all interception approaches
    const html = `<!DOCTYPE html>
<html><body>
<h2>Simulating OAuth redirect...</h2>
<script>
  // Wait a moment, then redirect (simulating SPA behavior)
  setTimeout(() => {
    try {
      window.location.href = "${EXPECTED_URL}";
    } catch(e) {
      document.title = "ERROR:" + e.message;
    }
  }, 500);
</script>
</body></html>`;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  console.log(`\nTest server on http://127.0.0.1:${port}`);
  console.log(`Expected URL: ${EXPECTED_URL}\n`);
  console.log("--- Testing redirect interception methods ---\n");

  const win = new BrowserWindow({
    width: 600,
    height: 400,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // --- Method 1: will-navigate ---
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("amical://")) {
      event.preventDefault();
      const success = url === EXPECTED_URL;
      log("1-will-navigate", success, url);
    }
  });

  // --- Method 1b: did-start-navigation ---
  win.webContents.on("did-start-navigation", (event, url) => {
    if (typeof url === "string" && url.startsWith("amical://")) {
      const success = url === EXPECTED_URL;
      log("1b-did-start-navigation", success, url);
    }
  });

  // --- Method 5: JS injection (location.href override) ---
  const injectJS = () => {
    win.webContents
      .executeJavaScript(
        `
      (function() {
        if (window.__amicalInterceptorInstalled) return;
        window.__amicalInterceptorInstalled = true;
        const desc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
        if (!desc || !desc.set) return;
        const origSet = desc.set;
        Object.defineProperty(window.location, 'href', {
          set(url) {
            if (typeof url === 'string' && url.startsWith('amical://')) {
              document.title = '__AMICAL_REDIRECT__' + url;
              return;
            }
            origSet.call(this, url);
          },
          get() { return desc.get.call(this); }
        });
      })();
      true;
    `
      )
      .catch(() => {});
  };

  win.webContents.on("did-finish-load", injectJS);

  win.on("page-title-updated", (_event, title) => {
    if (title.startsWith("__AMICAL_REDIRECT__")) {
      const url = title.substring("__AMICAL_REDIRECT__".length);
      const success = url === EXPECTED_URL;
      log("5-js-injection", success, url);
    }
    if (title.startsWith("ERROR:")) {
      console.log(`[INFO] Page error: ${title}`);
    }
  });

  // --- Method 2: webRequest.onBeforeRedirect ---
  win.webContents.session.webRequest.onBeforeRedirect((details) => {
    if (details.redirectURL.startsWith("amical://")) {
      const success = details.redirectURL === EXPECTED_URL;
      log("2-webRequest-onBeforeRedirect", success, details.redirectURL);
    }
  });

  // --- Method 3: webRequest.onBeforeRequest (no filter) ---
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.startsWith("amical://")) {
      const success = details.url === EXPECTED_URL;
      log("3-webRequest-onBeforeRequest", success, details.url);
      callback({ cancel: true });
      return;
    }
    callback({});
  });

  // Load the test page
  win.loadURL(`http://127.0.0.1:${port}`);

  // Wait for results and print summary
  setTimeout(() => {
    console.log("\n--- Summary ---\n");

    const methods = [
      "1-will-navigate",
      "1b-did-start-navigation",
      "2-webRequest-onBeforeRedirect",
      "3-webRequest-onBeforeRequest",
      "5-js-injection",
      "6-protocol-handle",
    ];

    for (const m of methods) {
      if (results[m]) {
        const r = results[m];
        console.log(`  ${r.success ? "PASS" : "FAIL"}  ${m}: ${r.url}`);
      } else {
        console.log(`  ----  ${m}: (not triggered)`);
      }
    }

    console.log("");
    const passing = Object.entries(results).filter(([, r]) => r.success);
    if (passing.length > 0) {
      console.log(
        `Working methods: ${passing.map(([k]) => k).join(", ")}`
      );
    } else {
      console.log("No method captured the full URL.");
    }

    server.close();
    app.quit();
  }, 3000);
});
