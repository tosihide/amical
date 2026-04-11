import * as fs from "node:fs";
import * as path from "node:path";
import { writeEvent } from "../rpc/stdout-writer.js";
import { getModifierFlags, isModifierKeyCode } from "./keycodes.js";

// Linux input event constants
const EV_KEY = 1;
// struct input_event on 64-bit: { uint64 sec, uint64 usec, uint16 type, uint16 code, int32 value }
const INPUT_EVENT_SIZE = 24;

// Track pressed keys globally for modifier state
const pressedKeys = new Set<number>();

export function getPressedKeys(): Set<number> {
  return pressedKeys;
}

function scanKeyboardDevices(): string[] {
  const devices: string[] = [];
  try {
    const inputDir = "/dev/input";
    const entries = fs.readdirSync(inputDir);
    for (const entry of entries) {
      if (!entry.startsWith("event")) continue;
      const devicePath = path.join(inputDir, entry);

      // Check read access first
      try {
        fs.accessSync(devicePath, fs.constants.R_OK);
      } catch {
        continue; // Skip devices we can't read
      }

      // Check if this is a keyboard by reading capabilities
      const capsPath = `/sys/class/input/${entry}/device/capabilities/key`;
      try {
        const caps = fs.readFileSync(capsPath, "utf-8").trim();
        if (caps && caps !== "0") {
          const parts = caps.split(" ");
          const totalBits = parts.reduce((sum: number, hex: string) => {
            // Use BigInt to handle 64-bit hex values correctly
            let count = 0;
            let n = BigInt(`0x${hex}`);
            while (n) {
              count += Number(n & 1n);
              n >>= 1n;
            }
            return sum + count;
          }, 0);
          // Real keyboards have many key capabilities (>20 bits set)
          if (totalBits > 20) {
            devices.push(devicePath);
          }
        }
      } catch {
        // Skip devices we can't inspect
      }
    }
  } catch (err) {
    process.stderr.write(`Failed to scan input devices: ${err}\n`);
  }
  return devices;
}

function parseInputEvent(
  buf: Buffer,
  offset: number,
): { type: number; code: number; value: number } | null {
  if (buf.length - offset < INPUT_EVENT_SIZE) return null;
  // Skip timestamp (16 bytes), read type, code, value
  const type = buf.readUInt16LE(offset + 16);
  const code = buf.readUInt16LE(offset + 18);
  const value = buf.readInt32LE(offset + 20);
  return { type, code, value };
}

function emitKeyEvent(
  eventType: "keyDown" | "keyUp" | "flagsChanged",
  keyCode: number,
): void {
  const flags = getModifierFlags(pressedKeys);
  const event = {
    type: eventType,
    payload: {
      keyCode,
      altKey: flags.altKey,
      ctrlKey: flags.ctrlKey,
      shiftKey: flags.shiftKey,
      metaKey: flags.metaKey,
      fnKeyPressed: pressedKeys.has(464), // KEY_FN
    },
    timestamp: new Date().toISOString(),
  };
  writeEvent(event);
}

function monitorDevice(devicePath: string): void {
  let fd: number;
  try {
    fd = fs.openSync(devicePath, "r");
  } catch (err) {
    process.stderr.write(`Cannot open ${devicePath}: ${err}\n`);
    return;
  }

  const buf = Buffer.alloc(INPUT_EVENT_SIZE * 64);

  function readLoop(): void {
    fs.read(fd, buf, 0, buf.length, null, (err, bytesRead) => {
      if (err) {
        process.stderr.write(`Error reading ${devicePath}: ${err.message}\n`);
        try { fs.closeSync(fd); } catch { /* ignore */ }
        // Retry after delay
        setTimeout(() => monitorDevice(devicePath), 5000);
        return;
      }

      if (bytesRead === 0) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        process.stderr.write(`Device ${devicePath} EOF, retrying in 5s\n`);
        setTimeout(() => monitorDevice(devicePath), 5000);
        return;
      }

      let offset = 0;
      while (offset + INPUT_EVENT_SIZE <= bytesRead) {
        const event = parseInputEvent(buf, offset);
        offset += INPUT_EVENT_SIZE;
        if (!event || event.type !== EV_KEY) continue;

        const { code, value } = event;

        if (value === 1) {
          pressedKeys.add(code);
          emitKeyEvent(isModifierKeyCode(code) ? "flagsChanged" : "keyDown", code);
        } else if (value === 0) {
          pressedKeys.delete(code);
          emitKeyEvent(isModifierKeyCode(code) ? "flagsChanged" : "keyUp", code);
        } else if (value === 2) {
          emitKeyEvent("keyDown", code);
        }
      }

      // Continue reading
      readLoop();
    });
  }

  readLoop();
}

export function startKeyboardMonitor(): void {
  const devices = scanKeyboardDevices();
  if (devices.length === 0) {
    const groups = fs.readFileSync("/proc/self/status", "utf-8").match(/^Groups:\s*(.*)$/m)?.[1] ?? "";
    const inputGid = fs.readFileSync("/etc/group", "utf-8").match(/^input:x:(\d+):/m)?.[1];
    const hint = inputGid && !groups.split(/\s+/).includes(inputGid) ? " User is NOT in 'input' group. Run: sudo usermod -aG input $USER (then re-login)" : "";
    process.stderr.write(`No readable keyboard devices found.${hint}\n`);
    return;
  }

  process.stderr.write(`Monitoring keyboard devices: ${devices.join(", ")}\n`);
  for (const device of devices) {
    monitorDevice(device);
  }
}
