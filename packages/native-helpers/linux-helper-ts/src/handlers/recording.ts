import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let wasMutedBeforeRecording = false;

async function getSinkMuteState(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("pactl", [
      "get-sink-mute",
      "@DEFAULT_SINK@",
    ]);
    return stdout.includes("yes");
  } catch {
    return false;
  }
}

export async function handleStartRecording(
  params: Record<string, unknown>,
): Promise<{ success: boolean; message?: string }> {
  const muteSystemAudio = params.muteSystemAudio === true;

  try {
    if (muteSystemAudio) {
      wasMutedBeforeRecording = await getSinkMuteState();
      if (!wasMutedBeforeRecording) {
        await execFileAsync("pactl", [
          "set-sink-mute",
          "@DEFAULT_SINK@",
          "1",
        ]);
      }
    }
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message };
  }
}

export async function handleStopRecording(
  params: Record<string, unknown>,
): Promise<{ success: boolean; message?: string }> {
  const wasMuted = params.wasMuted === true;

  try {
    if (wasMuted && !wasMutedBeforeRecording) {
      await execFileAsync("pactl", [
        "set-sink-mute",
        "@DEFAULT_SINK@",
        "0",
      ]);
    }
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message };
  }
}
