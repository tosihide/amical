import * as readline from "node:readline";
import { dispatch } from "./rpc/dispatcher.js";
import { startKeyboardMonitor } from "./evdev/monitor.js";

process.stderr.write("LinuxHelper: starting\n");

// Start evdev keyboard monitoring in parallel
startKeyboardMonitor();

// Track pending dispatches so we don't exit mid-flight
let pendingCount = 0;
let stdinClosed = false;

function maybeExit(): void {
  if (stdinClosed && pendingCount === 0) {
    process.stderr.write("LinuxHelper: all done, exiting\n");
    process.exit(0);
  }
}

// Read JSON-RPC requests from stdin (one JSON object per line)
const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const request = JSON.parse(trimmed);
    if (!request.id || !request.method) {
      process.stderr.write(`LinuxHelper: invalid request (missing id or method)\n`);
      return;
    }
    pendingCount++;
    dispatch(request)
      .catch((err) => {
        process.stderr.write(`LinuxHelper: dispatch error: ${err}\n`);
      })
      .finally(() => {
        pendingCount--;
        maybeExit();
      });
  } catch (err) {
    process.stderr.write(`LinuxHelper: JSON parse error: ${err}\n`);
  }
});

rl.on("close", () => {
  process.stderr.write("LinuxHelper: stdin closed\n");
  stdinClosed = true;
  maybeExit();
});

process.on("SIGTERM", () => {
  process.stderr.write("LinuxHelper: received SIGTERM, exiting\n");
  process.exit(0);
});

process.on("SIGINT", () => {
  process.stderr.write("LinuxHelper: received SIGINT, exiting\n");
  process.exit(0);
});
