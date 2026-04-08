/**
 * Store configured shortcut key arrays.
 * The evdev monitor uses these to determine which key events
 * are shortcut activations.
 */

interface ShortcutConfig {
  pushToTalk: number[];
  toggleRecording: number[];
  pasteLastTranscript: number[];
  newNote: number[];
}

let shortcuts: ShortcutConfig = {
  pushToTalk: [],
  toggleRecording: [],
  pasteLastTranscript: [],
  newNote: [],
};

export function getShortcuts(): ShortcutConfig {
  return shortcuts;
}

export async function handleSetShortcuts(
  params: Record<string, unknown>,
): Promise<{ success: boolean }> {
  shortcuts = {
    pushToTalk: (params.pushToTalk as number[]) ?? [],
    toggleRecording: (params.toggleRecording as number[]) ?? [],
    pasteLastTranscript: (params.pasteLastTranscript as number[]) ?? [],
    newNote: (params.newNote as number[]) ?? [],
  };
  return { success: true };
}
