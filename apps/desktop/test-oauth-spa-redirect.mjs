/**
 * Investigate what URL login.amical.ai actually redirects to after OAuth login.
 * Uses Playwright to automate the login flow and capture all navigation/redirects.
 */
import { chromium } from "playwright";

const AUTH_URL =
  "https://login.amical.ai/auth/sign-in?" +
  new URLSearchParams({
    client_id: "5a0dc096e6174e5f9eec0403b2a69a24",
    redirect_uri: "amical://oauth/callback",
    response_type: "code",
    scope: "openid profile email offline_access",
    state: "TEST_STATE_123",
    code_challenge: "TEST_CHALLENGE",
    code_challenge_method: "S256",
  }).toString();

const EMAIL = process.env.TEST_EMAIL || "";
const PASSWORD = process.env.TEST_PASSWORD || "";

async function main() {
  console.log("Launching browser...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Capture ALL requests and responses
  const allRedirects = [];

  page.on("request", (req) => {
    const url = req.url();
    if (
      url.includes("callback") ||
      url.includes("amical") ||
      url.includes("oauth2")
    ) {
      console.log(`[REQUEST] ${req.method()} ${url}`);
    }
  });

  page.on("response", (res) => {
    const url = res.url();
    const status = res.status();
    if (status >= 300 && status < 400) {
      const location = res.headers()["location"];
      console.log(`[REDIRECT ${status}] ${url} -> ${location}`);
      allRedirects.push({ from: url, to: location, status });
    }
    if (
      url.includes("callback") ||
      url.includes("amical") ||
      url.includes("oauth2")
    ) {
      console.log(`[RESPONSE ${status}] ${url}`);
    }
  });

  // Capture navigation events
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      console.log(`[NAVIGATE] ${frame.url()}`);
    }
  });

  // Capture console messages from the SPA
  page.on("console", (msg) => {
    const text = msg.text();
    if (
      text.includes("amical") ||
      text.includes("redirect") ||
      text.includes("callback")
    ) {
      console.log(`[CONSOLE] ${text}`);
    }
  });

  // Intercept any attempt to navigate to amical:// scheme
  await context.route("**://oauth/**", (route) => {
    console.log(`[ROUTE INTERCEPT] ${route.request().url()}`);
    route.abort();
  });

  console.log(`\nNavigating to auth URL...`);
  console.log(`URL: ${AUTH_URL}\n`);

  try {
    await page.goto(AUTH_URL, { waitUntil: "networkidle" });
  } catch (e) {
    console.log(`[GOTO ERROR] ${e.message}`);
  }

  console.log(`\nPage loaded. Current URL: ${page.url()}`);
  console.log("Looking for login form...\n");

  // Try to find and fill the login form
  try {
    // Wait for email input
    await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="email" i]', { timeout: 10000 });

    // Screenshot for debugging
    await page.screenshot({ path: "/tmp/amical-login-1.png" });
    console.log("[SCREENSHOT] /tmp/amical-login-1.png");

    // Fill email
    const emailInput = await page.$('input[type="email"], input[name="email"], input[placeholder*="email" i]');
    if (emailInput) {
      await emailInput.fill(EMAIL);
      console.log("[INPUT] Email filled");
    }

    // Fill password
    const passwordInput = await page.$('input[type="password"], input[name="password"]');
    if (passwordInput) {
      await passwordInput.fill(PASSWORD);
      console.log("[INPUT] Password filled");
    }

    await page.screenshot({ path: "/tmp/amical-login-2.png" });
    console.log("[SCREENSHOT] /tmp/amical-login-2.png");

    // Monitor for amical:// redirect by injecting JS BEFORE clicking submit
    await page.evaluate(() => {
      // Override location.href to capture the redirect
      const desc = Object.getOwnPropertyDescriptor(Location.prototype, "href");
      const origSet = desc.set;
      Object.defineProperty(window.location, "href", {
        set(url) {
          if (typeof url === "string" && url.startsWith("amical://")) {
            window.__amicalRedirectUrl = url;
            console.log("AMICAL_REDIRECT_CAPTURED: " + url);
            // Don't actually navigate
            return;
          }
          origSet.call(this, url);
        },
        get() {
          return desc.get.call(this);
        },
      });

      // Also override assign and replace
      const origAssign = window.location.assign;
      window.location.assign = function (url) {
        if (typeof url === "string" && url.startsWith("amical://")) {
          window.__amicalRedirectUrl = url;
          console.log("AMICAL_REDIRECT_CAPTURED (assign): " + url);
          return;
        }
        origAssign.call(this, url);
      };

      const origReplace = window.location.replace;
      window.location.replace = function (url) {
        if (typeof url === "string" && url.startsWith("amical://")) {
          window.__amicalRedirectUrl = url;
          console.log("AMICAL_REDIRECT_CAPTURED (replace): " + url);
          return;
        }
        origReplace.call(this, url);
      };

      console.log("Redirect interceptors installed");
    });

    // Click submit button
    const submitBtn = await page.$(
      'button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Continue")'
    );
    if (submitBtn) {
      console.log("[CLICK] Submit button");
      await submitBtn.click();
    } else {
      console.log("[WARN] No submit button found");
      // List all buttons
      const buttons = await page.$$eval("button", (btns) =>
        btns.map((b) => ({ text: b.textContent?.trim(), type: b.type }))
      );
      console.log("[INFO] Available buttons:", JSON.stringify(buttons));
    }

    // Wait for redirect
    console.log("\nWaiting for OAuth redirect...\n");

    // Poll for the captured redirect URL
    let redirectUrl = null;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(500);
      try {
        redirectUrl = await page.evaluate(() => window.__amicalRedirectUrl);
        if (redirectUrl) break;
      } catch (e) {
        // Page might have navigated away
        console.log(`[POLL ${i}] Page navigated to: ${page.url()}`);
        break;
      }
    }

    if (redirectUrl) {
      console.log("\n========================================");
      console.log("CAPTURED REDIRECT URL:");
      console.log(redirectUrl);
      console.log("========================================\n");

      // Parse and show components
      try {
        const url = new URL(redirectUrl);
        console.log("Scheme:", url.protocol);
        console.log("Host:", url.host);
        console.log("Pathname:", url.pathname);
        console.log("Search params:");
        for (const [k, v] of url.searchParams) {
          console.log(`  ${k}: ${v}`);
        }
      } catch (e) {
        console.log("URL parse error:", e.message);
      }
    } else {
      console.log("\n[RESULT] No amical:// redirect captured");
      console.log("Current page URL:", page.url());
      await page.screenshot({ path: "/tmp/amical-login-3.png" });
      console.log("[SCREENSHOT] /tmp/amical-login-3.png");

      // Check page content for clues
      const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500));
      console.log("[PAGE CONTENT]", bodyText);
    }
  } catch (e) {
    console.log(`[ERROR] ${e.message}`);
    await page.screenshot({ path: "/tmp/amical-login-error.png" });
    console.log("[SCREENSHOT] /tmp/amical-login-error.png");
  }

  console.log("\n--- All captured redirects ---");
  for (const r of allRedirects) {
    console.log(`  [${r.status}] ${r.from} -> ${r.to}`);
  }

  await browser.close();
}

main().catch(console.error);
