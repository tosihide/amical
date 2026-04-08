import { getPressedKeys } from "../evdev/monitor.js";

export async function handleRecheckPressedKeys(
  params: Record<string, unknown>,
): Promise<{ staleKeyCodes: number[] }> {
  const pressedKeyCodes = (params.pressedKeyCodes as number[]) ?? [];
  const actuallyPressed = getPressedKeys();

  // Keys that Electron thinks are pressed but evdev says are not
  const staleKeyCodes = pressedKeyCodes.filter(
    (code) => !actuallyPressed.has(code),
  );

  return { staleKeyCodes };
}
