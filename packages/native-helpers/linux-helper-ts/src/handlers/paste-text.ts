import { execFile } from "node:child_process";
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

    // Set clipboard to transcript
    await run("wl-copy", ["--"], transcript);

    // Small delay to ensure clipboard is set
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Simulate Ctrl+V via ydotool
    // keycode 29 = KEY_LEFTCTRL, 47 = KEY_V
    // format: keycode:down keycode:down keycode:up keycode:up
    await run("ydotool", ["key", "29:1", "47:1", "47:0", "29:0"]);

    // Restore clipboard after a delay if needed
    if (preserveClipboard && savedClipboard !== null) {
      setTimeout(async () => {
        try {
          await run("wl-copy", ["--"], savedClipboard!);
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
