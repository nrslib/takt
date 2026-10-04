export interface ExecutionSettings {
  worktreeMode: 'auto' | 'custom' | 'none';
  worktreePath: string;
  branch: string;
  baseBranch: string;
  autoPr: boolean;
  draftPr: boolean;
}

export interface ExecutionSettingsRequest {
  worktree: boolean | string;
  branch?: string;
  baseBranch?: string;
  autoPr: boolean;
  draftPr: boolean;
}

export declare function snapshotExecutionSettings(settings: ExecutionSettings): ExecutionSettings;
export declare function buildExecutionSettingsRequest(settings: ExecutionSettings): ExecutionSettingsRequest;

export declare function clampInspectorWidth(value: number, min: number, max: number): number;

export declare function isWorkflowCatalogReady(
  selectedProjectId: string,
  catalogProjectId: string,
  categories: readonly { workflows?: readonly unknown[] }[],
): boolean;

export declare function isCurrentWorkflowRequest(
  request: { requestId: number; projectId: string },
  currentRequestId: number,
  selectedProjectId: string,
): boolean;

export declare function sameRunSelection(
  left: { projectId: string; slug: string } | null,
  right: { projectId: string; slug: string } | null,
): boolean;

export interface RunRequestToken {
  generation: number;
  snapshotRevision: number;
  selection: { projectId: string; slug: string };
}

export declare function isCurrentRunRequest(
  request: RunRequestToken,
  currentGeneration: number,
  currentSelection: { projectId: string; slug: string } | null,
  currentSnapshotRevision: number,
): boolean;

export declare function projectSelectionForRefresh(
  preferredProjectId: string,
  currentProjectId: string,
): string;

export interface RunDetailViewState {
  scrollTop: number;
  openReportFilenames: readonly string[];
}

export declare function captureRunDetailViewState(runDetail: {
  scrollTop: number;
  querySelectorAll: (selector: string) => Iterable<{
    open: boolean;
    dataset: { reportFilename?: string };
  }>;
}): RunDetailViewState;

export declare function restoreRunDetailViewState(
  runDetail: {
    scrollTop: number;
    querySelectorAll: (selector: string) => Iterable<{
      open: boolean;
      dataset: { reportFilename?: string };
    }>;
  },
  state: RunDetailViewState,
): void;

export declare function shouldCloseExecutionContext(
  event: { composedPath?: () => unknown[]; target?: unknown },
  contextElement: { contains: (target: unknown) => boolean },
  dialogElement?: { open?: boolean },
): boolean;

export interface DirectoryRequestToken {
  dialogSessionId: number;
  requestId: number;
}

export type DirectoryOperation = 'browse' | 'native-picker' | 'select';

export interface DirectoryRequestTracker {
  openDialog(): void;
  closeDialog(): void;
  invalidateRequest(): void;
  beginRequest(kind?: DirectoryOperation): DirectoryRequestToken | null;
  beginPendingOperation(
    kind: Exclude<DirectoryOperation, 'browse'>,
  ): DirectoryRequestToken | null;
  isCurrent(token: DirectoryRequestToken | null): boolean;
  isCurrentOperation(kind: DirectoryOperation): boolean;
  hasPendingOperation(): boolean;
  finishRequest(token: DirectoryRequestToken): boolean;
  finishPendingOperation(token: DirectoryRequestToken): boolean;
}

export declare function createDirectoryRequestTracker(): DirectoryRequestTracker;
