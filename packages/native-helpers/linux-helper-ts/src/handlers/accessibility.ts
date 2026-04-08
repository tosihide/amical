import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";

const execFileAsync = promisify(execFile);

/**
 * Get active window info from GNOME Shell via D-Bus eval.
 */
async function getGnomeActiveWindow(): Promise<{
  appName: string | null;
  windowTitle: string | null;
  pid: number;
}> {
  const defaultResult = { appName: null, windowTitle: null, pid: 0 };

  try {
    // Get window title and WM class via GNOME Shell eval
    const script = `
      (function() {
        let w = global.display.get_focus_window();
        if (!w) return JSON.stringify({title: null, wmClass: null, pid: 0});
        return JSON.stringify({
          title: w.get_title(),
          wmClass: w.get_wm_class(),
          pid: w.get_pid()
        });
      })()
    `.trim();

    const { stdout } = await execFileAsync(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        "org.gnome.Shell",
        "--object-path",
        "/org/gnome/Shell",
        "--method",
        "org.gnome.Shell.Eval",
        script,
      ],
      { timeout: 3000 },
    );

    // gdbus returns: (true, '{"title":"...","wmClass":"...","pid":123}')
    const match = stdout.match(/\(true,\s*'(.+)'\)/s);
    if (!match) return defaultResult;

    const parsed = JSON.parse(match[1]);
    return {
      appName: parsed.wmClass ?? null,
      windowTitle: parsed.title ?? null,
      pid: parsed.pid ?? 0,
    };
  } catch {
    return defaultResult;
  }
}

export async function handleGetAccessibilityContext(
  _params: Record<string, unknown>,
): Promise<{ context: Record<string, unknown> | null }> {
  const windowInfo = await getGnomeActiveWindow();

  if (!windowInfo.appName && !windowInfo.windowTitle) {
    return { context: null };
  }

  return {
    context: {
      schemaVersion: "2.0",
      application: {
        name: windowInfo.appName,
        bundleIdentifier: null,
        version: null,
        pid: windowInfo.pid,
      },
      windowInfo: {
        title: windowInfo.windowTitle,
        url: null,
      },
      focusedElement: null,
      textSelection: null,
      timestamp: Math.floor(Date.now() / 1000),
      metrics: {
        totalTimeMs: 0,
        textMarkerAttempted: false,
        textMarkerSucceeded: false,
        fallbacksUsed: [],
        errors: [],
        timedOut: false,
        webAreaRetryAttempted: false,
        webAreaFound: false,
        webAreaRetrySucceeded: false,
      },
    },
  };
}

export async function handleGetAccessibilityStatus(
  _params: Record<string, unknown>,
): Promise<{ hasPermission: boolean; isEnabled: boolean }> {
  const checks = await Promise.all([
    checkCommand("wl-copy"),
    checkCommand("ydotool"),
    checkCommand("pactl"),
    checkEvdevAccess(),
  ]);

  const allAvailable = checks.every(Boolean);
  return { hasPermission: allAvailable, isEnabled: true };
}

export async function handleRequestAccessibilityPermission(
  _params: Record<string, unknown>,
): Promise<{ granted: boolean }> {
  // On Linux, permissions are managed via group membership
  // We can't programmatically grant them
  const status = await handleGetAccessibilityStatus({});
  return { granted: status.hasPermission };
}

export async function handleGetAccessibilityTreeDetails(
  _params: Record<string, unknown>,
): Promise<{ tree: null }> {
  // Stub - AT-SPI2 integration deferred
  return { tree: null };
}

async function checkCommand(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

async function checkEvdevAccess(): Promise<boolean> {
  try {
    const entries = fs.readdirSync("/dev/input");
    for (const entry of entries) {
      if (entry.startsWith("event")) {
        try {
          fs.accessSync(`/dev/input/${entry}`, fs.constants.R_OK);
          return true;
        } catch {
          continue;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}
