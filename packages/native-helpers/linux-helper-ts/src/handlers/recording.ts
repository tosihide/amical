import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs";

const execFileAsync = promisify(execFile);

let wasMutedBeforeRecording = false;

/**
 * Resolve the resources directory.
 * In development: <project>/resources/
 * When packaged: the binary sits in bin/, resources/ is a sibling directory.
 */
function getResourcesDir(): string {
  // Built layout: dist/handlers/recording.js → ../../resources/
  const fromDist = path.join(__dirname, "..", "..", "resources");
  if (fs.existsSync(fromDist)) return fromDist;
  // Source layout: src/handlers/recording.ts → ../../resources/
  const fromSrc = path.join(__dirname, "..", "..", "resources");
  if (fs.existsSync(fromSrc)) return fromSrc;
  // Packaged layout: bin/LinuxHelper → ../resources/
  const fromBin = path.join(path.dirname(process.argv[0] || __dirname), "..", "resources");
  if (fs.existsSync(fromBin)) return fromBin;
  return fromDist;
}

/**
 * Play a sound file using the best available player.
 * Detached so it doesn't block the RPC response.
 */
function playSound(soundName: string): void {
  const soundFile = path.join(getResourcesDir(), `${soundName}.mp3`);
  if (!fs.existsSync(soundFile)) {
    process.stderr.write(`Sound file not found: ${soundFile}\n`);
    return;
  }

  // Try gst-play-1.0 (GStreamer, widely available on Linux desktops)
  const child = spawn("gst-play-1.0", [soundFile], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  child.on("error", () => {
    // Fallback: try paplay (PulseAudio) — works only with WAV/OGG
    // mp3 via paplay requires libpulse mp3 support which is rare
    process.stderr.write(`gst-play-1.0 not available, sound skipped\n`);
  });
}

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
  const muteSounds = params.muteSounds === true;

  try {
    if (!muteSounds) {
      playSound("rec-start");
    }

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
  const muteSounds = params.muteSounds === true;

  try {
    if (wasMuted && !wasMutedBeforeRecording) {
      await execFileAsync("pactl", [
        "set-sink-mute",
        "@DEFAULT_SINK@",
        "0",
      ]);
    }

    if (!muteSounds) {
      playSound("rec-stop");
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message };
  }
}
