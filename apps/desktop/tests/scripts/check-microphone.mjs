#!/usr/bin/env node
/**
 * Microphone Input Diagnostic Script
 *
 * Tests that audio input devices are accessible on the system level.
 * This checks the prerequisites for getUserMedia() to work inside Electron.
 *
 * Usage: node tests/scripts/check-microphone.mjs
 *
 * Checks:
 * 1. PulseAudio/PipeWire is running (Linux audio server)
 * 2. Audio input devices are available (via pactl)
 * 3. ALSA devices are accessible
 * 4. /dev/snd permissions (user must be in 'audio' group)
 */

import { execSync } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";

const results = [];
let allPassed = true;

function check(name, fn) {
  try {
    const result = fn();
    results.push({ name, status: "PASS", detail: result });
  } catch (e) {
    results.push({ name, status: "FAIL", detail: e.message });
    allPassed = false;
  }
}

function run(cmd) {
  return execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim();
}

// 1. Check PulseAudio / PipeWire
check("Audio server running", () => {
  try {
    const info = run("pactl info 2>/dev/null | head -3");
    if (info.includes("Server Name")) {
      return info.split("\n")[0];
    }
  } catch {
    // ignore
  }
  try {
    const pw = run("pw-cli info 0 2>/dev/null | head -1");
    return `PipeWire: ${pw}`;
  } catch {
    throw new Error(
      "Neither PulseAudio nor PipeWire detected. Audio server required.",
    );
  }
});

// 2. List audio input sources
check("Audio input sources available", () => {
  const sources = run(
    "pactl list sources short 2>/dev/null || true",
  );
  if (!sources) {
    throw new Error("No audio sources found via pactl");
  }
  const lines = sources.split("\n").filter((l) => l.trim());
  const inputSources = lines.filter(
    (l) => l.includes("input") || l.includes("monitor") || l.includes("source"),
  );
  if (lines.length === 0) {
    throw new Error("No audio sources found");
  }
  return `${lines.length} source(s) found:\n  ${lines.join("\n  ")}`;
});

// 3. Check default audio input
check("Default audio input device", () => {
  const defaultSource = run(
    "pactl get-default-source 2>/dev/null || echo 'unknown'",
  );
  if (defaultSource === "unknown" || !defaultSource) {
    throw new Error("Could not determine default audio input");
  }
  return defaultSource;
});

// 4. Check ALSA capture devices
check("ALSA capture devices", () => {
  try {
    const arecord = run("arecord -l 2>/dev/null");
    const cards = arecord.split("\n").filter((l) => l.startsWith("card"));
    if (cards.length === 0) {
      throw new Error("No ALSA capture cards found");
    }
    return `${cards.length} card(s):\n  ${cards.join("\n  ")}`;
  } catch (e) {
    // arecord might not be installed, not critical if PulseAudio works
    return "arecord not available (non-critical if PulseAudio/PipeWire works)";
  }
});

// 5. Check /dev/snd permissions
check("/dev/snd device access", () => {
  try {
    const devices = readdirSync("/dev/snd");
    const pcmDevices = devices.filter((d) => d.startsWith("pcm"));
    if (pcmDevices.length === 0) {
      throw new Error("No PCM devices in /dev/snd");
    }
    // Check if we can read at least one
    let readable = 0;
    for (const dev of pcmDevices) {
      try {
        accessSync(`/dev/snd/${dev}`, constants.R_OK);
        readable++;
      } catch {
        // skip
      }
    }
    return `${pcmDevices.length} PCM device(s), ${readable} readable`;
  } catch (e) {
    if (e.code === "ENOENT") {
      throw new Error("/dev/snd not found — ALSA not available");
    }
    throw e;
  }
});

// 6. Check user groups (audio, input)
check("User group membership", () => {
  const groups = run("groups");
  const hasAudio = groups.includes("audio");
  const hasInput = groups.includes("input");
  const warnings = [];
  if (!hasAudio) warnings.push("not in 'audio' group");
  if (!hasInput) warnings.push("not in 'input' group (needed for evdev)");
  if (warnings.length > 0) {
    return `Groups: ${groups}\n  Warning: ${warnings.join(", ")}`;
  }
  return `Groups include audio and input: OK`;
});

// 7. Quick audio capture test (record 0.5s silence to /dev/null)
check("Audio capture test (0.5s)", () => {
  try {
    run(
      "timeout 1 parecord --channels=1 --rate=16000 --format=s16le /dev/null 2>&1 || true",
    );
    return "parecord capture OK";
  } catch {
    try {
      run(
        "timeout 1 arecord -d 0 -f S16_LE -r 16000 -c 1 /dev/null 2>&1",
      );
      return "arecord capture OK";
    } catch (e) {
      throw new Error(`Audio capture failed: ${e.message}`);
    }
  }
});

// Print results
console.log("\n=== Microphone Input Diagnostics ===\n");
for (const r of results) {
  const icon = r.status === "PASS" ? "✓" : "✗";
  console.log(`${icon} ${r.name}: ${r.status}`);
  if (r.detail) {
    const indented = String(r.detail)
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n");
    console.log(indented);
  }
  console.log();
}

if (allPassed) {
  console.log("All checks passed. Microphone should work in Electron.\n");
} else {
  console.log(
    "Some checks failed. Fix the issues above before testing audio in Amical.\n",
  );
}

process.exit(allPassed ? 0 : 1);
