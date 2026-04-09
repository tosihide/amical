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
function runWlCopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("wl-copy", ["--", text], {
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
 * Detect ydotool version and simulate Ctrl+V accordingly.
 * v0.1.x uses: ydotool key ctrl+v
 * v1.x+  uses: ydotool key 29:1 47:1 47:0 29:0
 */
async function simulateCtrlV(): Promise<void> {
  try {
    // Try v0.1.x format first (more common on Ubuntu 24.04)
    await run("ydotool", ["key", "ctrl+v"]);
  } catch {
    // Fallback: try v1.x format
    await run("ydotool", ["key", "29:1", "47:1", "47:0", "29:0"]);
  }
}

export async function handlePasteText(
  params: Record<string, unknown>,
): Promise<{ success: boolean; message?: string }> {
  const transcript = params.transcript as string;
  const preserveClipboard = params.preserveClipboard !== false;

  if (!transcript) {
    return { success: false, message: "No transcript provided" };
  }

  let savedClipboard: string | null = null;

  try {
    // Save current clipboard if requested
    if (preserveClipboard) {
      try {
        savedClipboard = await run("wl-paste", ["--no-newline"]);
      } catch {
        // Clipboard might be empty, that's OK
        savedClipboard = "";
      }
    }

    // Set clipboard to transcript (detached — wl-copy stays resident)
    await runWlCopy(transcript);

    // Small delay to ensure clipboard is set
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Simulate Ctrl+V
    await simulateCtrlV();

    // Restore clipboard after a delay if needed
    if (preserveClipboard && savedClipboard !== null) {
      setTimeout(async () => {
        try {
          await runWlCopy(savedClipboard!);
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
