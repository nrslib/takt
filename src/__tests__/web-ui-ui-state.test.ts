import { describe, expect, it } from 'vitest';
import {
  clampChatPaneWidth,
  createDirectoryRequestTracker,
  getChatPaneWidthBounds,
  resolveChatPaneWidth,
  shouldCloseExecutionContext,
} from '../../web-ui/public/ui-state.js';
import type { DirectoryRequestToken } from '../../web-ui/public/ui-state.js';

describe('Web UI chat pane state', () => {
  it('keeps the chat and runs panes within their minimum widths', () => {
    expect(getChatPaneWidthBounds(430)).toEqual({ min: 320, max: 320 });
    expect(clampChatPaneWidth(100, 1200)).toBe(320);
    expect(clampChatPaneWidth(1000, 1200)).toBe(760);
  });

  it('recomputes an unadjusted default and clamps a manually adjusted width', () => {
    expect(resolveChatPaneWidth(1200, 320, false)).toBe(600);
    expect(resolveChatPaneWidth(1200, 700, true)).toBe(700);
    expect(resolveChatPaneWidth(900, 700, true)).toBe(460);
  });
});

function requireDirectoryRequest(
  token: DirectoryRequestToken | null,
): DirectoryRequestToken {
  expect(token).not.toBeNull();
  if (token === null) throw new Error('expected a directory request token');
  return token;
}

describe('Web UI directory request state', () => {
  it('makes native-picker and selection operations mutually exclusive', () => {
    const requests = createDirectoryRequestTracker();
    requests.openDialog();

    const browseRequest = requireDirectoryRequest(requests.beginRequest('browse'));
    const nativePickerRequest = requireDirectoryRequest(
      requests.beginPendingOperation('native-picker'),
    );
    expect(requests.isCurrent(browseRequest)).toBe(false);
    expect(requests.isCurrent(nativePickerRequest)).toBe(true);
    expect(requests.isCurrentOperation('native-picker')).toBe(true);
    expect(requests.hasPendingOperation()).toBe(true);
    expect(requests.beginPendingOperation('select')).toBeNull();
    expect(requests.beginRequest('browse')).toBeNull();
    expect(requests.finishRequest(browseRequest)).toBe(false);

    expect(requests.finishPendingOperation(nativePickerRequest)).toBe(true);
    expect(requests.hasPendingOperation()).toBe(false);
    const selectionRequest = requireDirectoryRequest(
      requests.beginPendingOperation('select'),
    );
    expect(requests.isCurrentOperation('select')).toBe(true);
    expect(requests.hasPendingOperation()).toBe(true);
    expect(requests.finishPendingOperation(selectionRequest)).toBe(true);
  });

  it('rejects stale completion after invalidation, close, and reopen', () => {
    const requests = createDirectoryRequestTracker();
    requests.openDialog();

    const nativePickerRequest = requireDirectoryRequest(
      requests.beginPendingOperation('native-picker'),
    );
    requests.invalidateRequest();
    expect(requests.hasPendingOperation()).toBe(false);
    expect(requests.finishPendingOperation(nativePickerRequest)).toBe(false);

    const staleNativePickerRequest = requireDirectoryRequest(
      requests.beginPendingOperation('native-picker'),
    );
    requests.closeDialog();
    requests.openDialog();
    const reopenedNativePickerRequest = requireDirectoryRequest(
      requests.beginPendingOperation('native-picker'),
    );
    expect(requests.finishPendingOperation(staleNativePickerRequest)).toBe(false);
    expect(requests.hasPendingOperation()).toBe(true);
    expect(requests.finishPendingOperation(reopenedNativePickerRequest)).toBe(true);

    const selectionRequest = requireDirectoryRequest(
      requests.beginPendingOperation('select'),
    );
    requests.closeDialog();
    expect(requests.isCurrent(selectionRequest)).toBe(false);
    expect(requests.finishPendingOperation(selectionRequest)).toBe(false);

    requests.openDialog();
    const reopenedRequest = requireDirectoryRequest(requests.beginRequest('browse'));
    expect(requests.isCurrent(selectionRequest)).toBe(false);
    expect(requests.isCurrent(reopenedRequest)).toBe(true);
    const secondNativePickerRequest = requireDirectoryRequest(
      requests.beginPendingOperation('native-picker'),
    );
    expect(requests.finishRequest(reopenedRequest)).toBe(false);
    expect(requests.finishPendingOperation(selectionRequest)).toBe(false);
    expect(requests.finishPendingOperation(secondNativePickerRequest)).toBe(true);
  });
});

describe('Web UI execution context boundary', () => {
  const context = { contains: () => false };
  const dialog = { open: false };

  it('closes only for a composed event path outside the context', () => {
    expect(shouldCloseExecutionContext({ composedPath: () => [context] }, context, dialog)).toBe(false);
    expect(shouldCloseExecutionContext({ composedPath: () => [context, {}] }, context, dialog)).toBe(false);
    expect(shouldCloseExecutionContext({ composedPath: () => [{}] }, context, dialog)).toBe(true);
  });

  it('keeps the context open while a directory dialog owns the event', () => {
    const openDialog = { open: true };
    expect(shouldCloseExecutionContext({ composedPath: () => [openDialog, {}] }, context, openDialog)).toBe(false);
    expect(shouldCloseExecutionContext({ composedPath: () => [{}] }, context, openDialog)).toBe(true);
  });

  it('keeps the context open for a dialog close click after the dialog state flips closed', () => {
    const closedDialog = { open: false };
    expect(shouldCloseExecutionContext({ composedPath: () => [closedDialog, {}] }, context, closedDialog)).toBe(false);
  });
});
