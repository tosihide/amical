import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function run(
  cmd: string,
  args: string[],
  input?: string,
): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, {
    timeout: 5000,
    encoding: "utf-8",
    ...(input !== undefined && { input }),
  });
  return stdout;
}

/**
 * Run wl-copy in a detached process.
 * wl-copy forks and stays resident to serve clipboard requests,
 * so we must detach it to avoid blocking the caller.
 */
function runWlCopy(text: string, primary = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = primary ? ["--primary", "--", text] : ["--", text];
    const child = spawn("wl-copy", args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    child.on("error", reject);
    // wl-copy forks quickly; give it a moment to set up
    setTimeout(resolve, 100);
  });
}

/**
 * Simulate paste via keyboard shortcut.
 * Uses Shift+Insert which works across GUI apps AND terminals,
 * unlike Ctrl+V (fails in terminals) or Ctrl+Shift+V (opens
 * Markdown preview in VS Code).
 *
 * Supports ydotool v0.1.x (key name format) and v1.x+ (keycode format).
 */
async function simulatePaste(): Promise<void> {
  try {
    // Try v0.1.x format first (more common on Ubuntu 24.04)
    await run("ydotool", ["key", "shift+Insert"]);
  } catch {
    // Fallback: try v1.x format (keycode 42=SHIFT, 110=INSERT)
    await run("ydotool", ["key", "42:1", "110:1", "110:0", "42:0"]);
  }
}

export async function handlePasteText(
  params: Record<string, unknown>,
): Promise<{ success: boolean; message?: string }> {
  const transcript = params.transcript as string;
  const preserveClipboard = params.preserveClipboard !== false;
  const keystrokeOnly = params.keystrokeOnly === true;

  if (!transcript && !keystrokeOnly) {
    return { success: false, message: "No transcript provided" };
  }

  try {
    if (keystrokeOnly) {
      // Mode 1: Electron already set the clipboard via its synchronous API.
      // We only need to simulate the paste keystroke.
      await simulatePaste();
      return { success: true };
    }

    // Mode 2 (fallback): Handle clipboard entirely in the helper via wl-copy.
    // Kept for backwards compatibility or when Electron clipboard is unavailable.
    let savedClipboard: string | null = null;

    // Save current clipboard if requested
    if (preserveClipboard) {
      try {
        savedClipboard = await run("wl-paste", ["--no-newline"]);
      } catch {
        // Clipboard might be empty, that's OK
        savedClipboard = "";
      }
    }

    // Set both CLIPBOARD and PRIMARY selection so that Shift+Insert
    // works regardless of whether the app reads from CLIPBOARD or PRIMARY.
    await runWlCopy(transcript, false);
    await runWlCopy(transcript, true);

    // Wait for clipboard to be ready
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Simulate paste (Shift+Insert — works in both GUI apps and terminals)
    await simulatePaste();

    // Restore clipboard after a delay if needed
    if (preserveClipboard && savedClipboard !== null) {
      setTimeout(async () => {
        try {
          await Promise.all([
            runWlCopy(savedClipboard!, false),
            runWlCopy(savedClipboard!, true),
          ]);
        } catch {
          // Best effort
        }
      }, 500);
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message };
  }
}
