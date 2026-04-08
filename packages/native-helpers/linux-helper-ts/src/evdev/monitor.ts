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

/**
 * Check if a specific key is physically pressed using EVIOCGKEY ioctl.
 * Returns null if check fails.
 */
export function isKeyPhysicallyPressed(
  fd: number,
  keyCode: number,
): boolean | null {
  try {
    // EVIOCGKEY(len) = _IOC(_IOC_READ, 'E', 0x18, len)
    // For KEY_MAX=0x2ff, we need (0x2ff/8)+1 = 96 bytes
    const KEY_MAX_BYTES = 96;
    const EVIOCGKEY = 0x80604518; // _IOR('E', 0x18, 96 bytes)
    const buf = Buffer.alloc(KEY_MAX_BYTES);

    // Use ioctl via a raw syscall - for now use fs operations
    // Since Node.js doesn't have native ioctl, we check our tracked state
    // This is a simplification; a full implementation would use node-ffi or a native addon
    return pressedKeys.has(keyCode);
  } catch {
    return null;
  }
}

function scanKeyboardDevices(): string[] {
  const devices: string[] = [];
  try {
    const inputDir = "/dev/input";
    const entries = fs.readdirSync(inputDir);
    for (const entry of entries) {
      if (!entry.startsWith("event")) continue;
      const devicePath = path.join(inputDir, entry);

      // Check if this is a keyboard by reading /sys/class/input/<name>/device/capabilities/ev
      const sysName = entry; // e.g., "event0"
      const capsPath = `/sys/class/input/${sysName}/device/capabilities/key`;
      try {
        const caps = fs.readFileSync(capsPath, "utf-8").trim();
        // A keyboard device will have bits set in the KEY capability range
        // Check if the device has at least some key capabilities
        if (caps && caps !== "0") {
          // Further check: real keyboards have extensive key maps
          // Filter out devices with only a few button bits (mice, etc.)
          const parts = caps.split(" ");
          const totalBits = parts.reduce((sum, hex) => {
            let count = 0;
            let n = parseInt(hex, 16);
            while (n) {
              count += n & 1;
              n >>= 1;
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
): { type: number; code: number; value: number; timeSec: bigint; timeUsec: bigint } | null {
  if (buf.length - offset < INPUT_EVENT_SIZE) return null;
  const timeSec = buf.readBigUInt64LE(offset);
  const timeUsec = buf.readBigUInt64LE(offset + 8);
  const type = buf.readUInt16LE(offset + 16);
  const code = buf.readUInt16LE(offset + 18);
  const value = buf.readInt32LE(offset + 20);
  return { type, code, value, timeSec, timeUsec };
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
      key: null,
      code: null,
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
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(devicePath, {
      flags: "r",
      highWaterMark: INPUT_EVENT_SIZE * 64,
    });
  } catch (err) {
    process.stderr.write(`Cannot open ${devicePath}: ${err}\n`);
    return;
  }

  let remainder = Buffer.alloc(0);

  stream.on("data", (chunk: Buffer | string) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const data = Buffer.concat([remainder, buf]);
    let offset = 0;

    while (offset + INPUT_EVENT_SIZE <= data.length) {
      const event = parseInputEvent(data, offset);
      offset += INPUT_EVENT_SIZE;
      if (!event || event.type !== EV_KEY) continue;

      const { code, value } = event;

      if (value === 1) {
        // Key down
        pressedKeys.add(code);
        if (isModifierKeyCode(code)) {
          emitKeyEvent("flagsChanged", code);
        } else {
          emitKeyEvent("keyDown", code);
        }
      } else if (value === 0) {
        // Key up
        pressedKeys.delete(code);
        if (isModifierKeyCode(code)) {
          emitKeyEvent("flagsChanged", code);
        } else {
          emitKeyEvent("keyUp", code);
        }
      } else if (value === 2) {
        // Key repeat - treat as keyDown
        emitKeyEvent("keyDown", code);
      }
    }

    remainder = data.subarray(offset);
  });

  stream.on("error", (err) => {
    process.stderr.write(`Error reading ${devicePath}: ${err.message}\n`);
  });

  stream.on("close", () => {
    process.stderr.write(`Device ${devicePath} closed, will retry in 5s\n`);
    setTimeout(() => monitorDevice(devicePath), 5000);
  });
}

export function startKeyboardMonitor(): void {
  const devices = scanKeyboardDevices();
  if (devices.length === 0) {
    process.stderr.write(
      "No keyboard devices found. Ensure user is in 'input' group.\n",
    );
    return;
  }

  process.stderr.write(`Monitoring keyboard devices: ${devices.join(", ")}\n`);
  for (const device of devices) {
    monitorDevice(device);
  }
}
