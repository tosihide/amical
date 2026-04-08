import { writeResponse, writeError } from "./stdout-writer.js";
import { handlePasteText } from "../handlers/paste-text.js";
import { handleStartRecording, handleStopRecording } from "../handlers/recording.js";
import { handleSetShortcuts } from "../handlers/shortcuts.js";
import { handleRecheckPressedKeys } from "../handlers/recheck-pressed-keys.js";
import {
  handleGetAccessibilityContext,
  handleGetAccessibilityStatus,
  handleRequestAccessibilityPermission,
  handleGetAccessibilityTreeDetails,
} from "../handlers/accessibility.js";

interface RpcRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

type Handler = (params: Record<string, unknown>) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  pasteText: handlePasteText,
  startRecording: handleStartRecording,
  stopRecording: handleStopRecording,
  setShortcuts: handleSetShortcuts,
  recheckPressedKeys: handleRecheckPressedKeys,
  getAccessibilityContext: handleGetAccessibilityContext,
  getAccessibilityStatus: handleGetAccessibilityStatus,
  requestAccessibilityPermission: handleRequestAccessibilityPermission,
  getAccessibilityTreeDetails: handleGetAccessibilityTreeDetails,
};

export async function dispatch(request: RpcRequest): Promise<void> {
  const { id, method, params } = request;
  const handler = handlers[method];

  if (!handler) {
    writeError(id, -32601, `Method not found: ${method}`);
    return;
  }

  try {
    const result = await handler(params ?? {});
    writeResponse(id, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeError(id, -32603, message);
  }
}
