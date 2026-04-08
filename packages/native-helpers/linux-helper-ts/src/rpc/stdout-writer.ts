/**
 * Thread-safe stdout writer.
 * Both RPC responses and evdev keyboard events write to stdout,
 * so we serialize writes to prevent interleaving.
 */

const writeQueue: string[] = [];
let writing = false;

function flush(): void {
  if (writing || writeQueue.length === 0) return;
  writing = true;
  const line = writeQueue.shift()!;
  process.stdout.write(line + "\n", () => {
    writing = false;
    flush();
  });
}

export function writeLine(obj: unknown): void {
  writeQueue.push(JSON.stringify(obj));
  flush();
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
