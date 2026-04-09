/**
 * Test: Can Electron capture a full amical:// URL from a 302 redirect?
 * This simulates what core.amical.ai/api/auth/oauth2/authorize does.
 */
import { app, BrowserWindow, protocol } from "electron";
import { createServer } from "http";

const EXPECTED_URL = "amical://oauth/callback?code=TESTCODE&state=TESTSTATE";

protocol.registerSchemesAsPrivileged([{
  scheme: "amical",
  privileges: { standard: false, secure: false, supportFetchAPI: false, bypassCSP: true },
}]);

const results = {};
function log(method, url) {
  if (results[method]) return;
  const success = url === EXPECTED_URL;
  results[method] = { success, url };
  console.log("[" + (success ? "PASS" : "FAIL") + "] " + method + ": " + url);
}

app.whenReady().then(async () => {
  // Server that returns 302 redirect to amical://
  const server = createServer((req, res) => {
    if (req.url === "/authorize") {
      res.writeHead(302, { Location: EXPECTED_URL });
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><a href='/authorize'>Click to authorize</a></body></html>");
    }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  console.log("Test server: http://127.0.0.1:" + port);
  console.log("Expected: " + EXPECTED_URL + "\n");

  protocol.handle("amical", (request) => {
    log("protocol-handle", request.url);
    return new Response("ok");
  });

  const win = new BrowserWindow({
    width: 600, height: 400, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  // Test all events
  win.webContents.on("will-navigate", (ev, url) => {
    if (url.startsWith("amical://")) { ev.preventDefault(); log("will-navigate", url); }
  });

  win.webContents.on("will-redirect", (ev, url) => {
    if (url.startsWith("amical://")) { ev.preventDefault(); log("will-redirect", url); }
  });

  win.webContents.on("did-start-navigation", (ev, url) => {
    if (typeof url === "string" && url.startsWith("amical://")) { log("did-start-navigation", url); }
  });

  win.webContents.on("did-navigate", (ev, url) => {
    if (url.startsWith("amical://")) { log("did-navigate", url); }
  });

  win.webContents.on("did-redirect-navigation", (ev, url) => {
    if (typeof url === "string" && url.startsWith("amical://")) { log("did-redirect-navigation", url); }
  });

  // webRequest events
  win.webContents.session.webRequest.onBeforeRedirect((details) => {
    if (details.redirectURL.startsWith("amical://")) {
      log("webRequest-onBeforeRedirect", details.redirectURL);
    }
  });

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const location = details.responseHeaders?.["location"]?.[0] || 
                     details.responseHeaders?.["Location"]?.[0];
    if (location && location.startsWith("amical://")) {
      log("webRequest-onHeadersReceived", location);
    }
    callback({});
  });

  // Load the page and navigate to /authorize (triggers 302)
  await win.loadURL("http://127.0.0.1:" + port);
  win.loadURL("http://127.0.0.1:" + port + "/authorize");

  setTimeout(() => {
    console.log("\n--- Summary ---\n");
    const methods = ["will-navigate","will-redirect","did-start-navigation","did-navigate",
      "did-redirect-navigation","webRequest-onBeforeRedirect","webRequest-onHeadersReceived","protocol-handle"];
    for (const m of methods) {
      if (results[m]) {
        console.log("  " + (results[m].success ? "PASS" : "FAIL") + "  " + m + ": " + results[m].url);
      } else {
        console.log("  ----  " + m + ": (not triggered)");
      }
    }
    const passing = Object.entries(results).filter(([,r]) => r.success);
    console.log("\nWorking: " + (passing.length ? passing.map(([k]) => k).join(", ") : "NONE"));
    server.close();
    app.quit();
  }, 3000);
});
