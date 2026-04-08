/**
 * Serialized stdout writer.
 * Both RPC responses and evdev keyboard events write to stdout,
 * so we serialize writes to prevent interleaving.
 * Uses synchronous writes to ensure output is flushed before process exits.
 */

import * as fs from "node:fs";

const STDOUT_FD = 1;

export function writeLine(obj: unknown): void {
  const line = JSON.stringify(obj) + "\n";
  fs.writeSync(STDOUT_FD, line);
}

export function writeResponse(id: string, result: unknown): void {
  writeLine({ id, result });
}

export function writeError(
  id: string,
  code: number,
  message: string,
  data?: unknown,
): void {
  writeLine({ id, error: { code, message, data } });
}

export function writeEvent(event: unknown): void {
  writeLine(event);
}
