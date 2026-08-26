import { describe, expect, it } from 'vitest';
import {
  buildExecutionSettingsRequest,
  captureRunDetailViewState,
  clampChatPaneWidth,
  createDirectoryRequestTracker,
  getChatPaneWidthBounds,
  isCurrentWorkflowRequest,
  isWorkflowCatalogReady,
  projectSelectionForRefresh,
  resolveChatPaneWidth,
  restoreRunDetailViewState,
  sameRunSelection,
  snapshotExecutionSettings,
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

describe('Web UI execution settings', () => {
  it('keeps a task instruction snapshot independent from later setup changes', () => {
    const current = {
      worktreeMode: 'auto' as const,
      worktreePath: '',
      branch: 'feature/original',
      baseBranch: 'main',
      autoPr: true,
      draftPr: true,
    };
    const snapshot = snapshotExecutionSettings(current);

    current.branch = 'feature/next';
    current.autoPr = false;

    expect(buildExecutionSettingsRequest(snapshot)).toEqual({
      worktree: true,
      branch: 'feature/original',
      baseBranch: 'main',
      autoPr: true,
      draftPr: true,
    });
  });

  it('maps custom and disabled worktree settings to the launch boundary', () => {
    expect(buildExecutionSettingsRequest({
      worktreeMode: 'custom',
      worktreePath: '/tmp/takt-worktrees',
      branch: '',
      baseBranch: '',
      autoPr: false,
      draftPr: false,
    })).toEqual({
      worktree: '/tmp/takt-worktrees',
      autoPr: false,
      draftPr: false,
    });
    expect(buildExecutionSettingsRequest({
      worktreeMode: 'none',
      worktreePath: '',
      branch: '',
      baseBranch: '',
      autoPr: false,
      draftPr: false,
    })).toEqual({
      worktree: false,
      autoPr: false,
      draftPr: false,
    });
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

describe('Web UI execution readiness and run detail view state', () => {
  it('requires the selected project and a populated catalog', () => {
    const categories = [{ workflows: [{ id: 'default' }] }];
    expect(isWorkflowCatalogReady('project-a', 'project-a', categories)).toBe(true);
    expect(isWorkflowCatalogReady('project-a', 'project-b', categories)).toBe(false);
    expect(isWorkflowCatalogReady('project-a', 'project-a', [{ workflows: [] }])).toBe(false);
    expect(isWorkflowCatalogReady('', 'project-a', categories)).toBe(false);
  });

  it('preserves open reports and scroll position across detail replacement', () => {
    const firstReport = { dataset: { reportFilename: 'first.md' }, open: true };
    const secondReport = { dataset: { reportFilename: 'second.md' }, open: false };
    const selectors: string[] = [];
    const runDetail = {
      scrollTop: 42,
      querySelectorAll: (selector: string) => {
        selectors.push(selector);
        return [firstReport, secondReport];
      },
    };

    const state = captureRunDetailViewState(runDetail);
    firstReport.open = false;
    secondReport.open = true;
    runDetail.scrollTop = 0;

    restoreRunDetailViewState(runDetail, state);

    expect(firstReport.open).toBe(true);
    expect(secondReport.open).toBe(false);
    expect(runDetail.scrollTop).toBe(42);
    expect(selectors).toEqual([
      'details.report[data-report-filename]',
      'details.report[data-report-filename]',
    ]);
  });

  it('accepts only the current workflow request for the selected project', () => {
    const requestA1 = { requestId: 1, projectId: 'project-a' };
    const requestB = { requestId: 2, projectId: 'project-b' };
    const requestA2 = { requestId: 3, projectId: 'project-a' };

    expect(isCurrentWorkflowRequest(requestA1, requestA2.requestId, 'project-a')).toBe(false);
    expect(isCurrentWorkflowRequest(requestB, requestA2.requestId, 'project-a')).toBe(false);
    expect(isCurrentWorkflowRequest(requestA2, requestA2.requestId, 'project-a')).toBe(true);
  });

  it('requires both project and slug for an in-flight run detail', () => {
    const projectA = { projectId: 'project-a', slug: 'same-slug' };
    const projectB = { projectId: 'project-b', slug: 'same-slug' };
    expect(sameRunSelection(projectA, projectA)).toBe(true);
    expect(sameRunSelection(projectA, projectB)).toBe(false);
    expect(sameRunSelection(projectA, null)).toBe(false);
  });

  it('keeps a user selection made during refresh instead of restoring the old one', () => {
    expect(projectSelectionForRefresh('project-a', 'project-a')).toBe('project-a');
    expect(projectSelectionForRefresh('project-a', 'project-b')).toBe('project-b');
    expect(projectSelectionForRefresh('', 'project-b')).toBe('project-b');
  });
});
