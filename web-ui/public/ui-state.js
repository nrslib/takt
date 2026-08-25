export const CHAT_PANE_MIN_WIDTH = 320;
export const RUNS_PANE_MIN_WIDTH = 430;
export const CHAT_DIVIDER_WIDTH = 10;

export function getChatPaneWidthBounds(workspaceWidth) {
  return {
    min: CHAT_PANE_MIN_WIDTH,
    max: Math.max(
      CHAT_PANE_MIN_WIDTH,
      workspaceWidth - RUNS_PANE_MIN_WIDTH - CHAT_DIVIDER_WIDTH,
    ),
  };
}

export function clampChatPaneWidth(requestedWidth, workspaceWidth) {
  const bounds = getChatPaneWidthBounds(workspaceWidth);
  return Math.min(Math.max(requestedWidth, bounds.min), bounds.max);
}

export function resolveChatPaneWidth(workspaceWidth, currentWidth, manuallyAdjusted) {
  return clampChatPaneWidth(
    manuallyAdjusted ? currentWidth : workspaceWidth / 2,
    workspaceWidth,
  );
}

export function shouldCloseExecutionContext(event, contextElement, dialogElement) {
  const eventPath = typeof event.composedPath === 'function'
    ? event.composedPath()
    : [event.target];
  if (eventPath.includes(contextElement)) return false;
  // Keep the context open for the click that closes the directory dialog too:
  // the dialog's close handler runs before this document-level click listener.
  if (dialogElement !== undefined && eventPath.includes(dialogElement)) return false;
  if (typeof Node !== 'undefined' && event.target instanceof Node && contextElement.contains(event.target)) {
    return false;
  }
  return true;
}

export function createDirectoryRequestTracker() {
  let dialogSessionId = 0;
  let requestId = 0;
  let dialogOpen = false;
  let activeOperation = null;

  function isCurrent(token) {
    return token !== null
      && dialogOpen
      && token.dialogSessionId === dialogSessionId
      && token.requestId === requestId;
  }

  function isCurrentOperation(kind) {
    return activeOperation?.kind === kind
      && isCurrent(activeOperation.token);
  }

  function hasPendingOperation() {
    return activeOperation?.pending === true
      && isCurrent(activeOperation.token);
  }

  function finishRequest(token) {
    if (!isCurrent(token) || activeOperation?.pending === true) return false;
    activeOperation = null;
    return true;
  }

  function finishPendingOperation(token) {
    if (!hasPendingOperation() || activeOperation?.token !== token) return false;
    activeOperation = null;
    return true;
  }

  return {
    openDialog() {
      dialogSessionId += 1;
      requestId += 1;
      dialogOpen = true;
      activeOperation = null;
    },
    closeDialog() {
      if (!dialogOpen) {
        activeOperation = null;
        return;
      }
      dialogSessionId += 1;
      requestId += 1;
      dialogOpen = false;
      activeOperation = null;
    },
    invalidateRequest() {
      requestId += 1;
      activeOperation = null;
    },
    beginRequest(kind = 'browse') {
      if (!dialogOpen || activeOperation?.pending === true) return null;
      requestId += 1;
      const token = { dialogSessionId, requestId };
      activeOperation = { kind, pending: false, token };
      return token;
    },
    beginPendingOperation(kind) {
      if (!dialogOpen || activeOperation?.pending === true) return null;
      requestId += 1;
      const token = { dialogSessionId, requestId };
      activeOperation = { kind, pending: true, token };
      return token;
    },
    isCurrent,
    isCurrentOperation,
    hasPendingOperation,
    finishRequest,
    finishPendingOperation,
  };
}
