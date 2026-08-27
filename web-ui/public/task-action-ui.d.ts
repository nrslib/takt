export interface TaskActionButtonModel {
  readonly taskId: string;
  readonly action: string;
  readonly labelKey: string;
}

export function taskActionButtonModel(
  task: { readonly taskId: string },
  action: string,
): TaskActionButtonModel;

export function taskActionNeedsConfirmation(action: string): boolean;

export interface TaskActionRequest {
  readonly path: string;
  readonly body: {
    readonly projectId: string;
    readonly input?: string;
    readonly conversationId?: string;
    readonly taskActionOptionId?: string;
  };
}

export interface TaskActionRetryOption {
  readonly id: string;
  readonly label?: string;
  readonly selectable?: boolean;
  readonly description?: string;
}

export interface TaskActionRetryStartOptions {
  readonly defaultId: string;
  readonly options: readonly TaskActionRetryOption[];
}

export interface TaskActionReference {
  readonly sessionId: string;
  readonly taskId: string;
  readonly action: string;
  readonly generation?: number;
  readonly retryStartOptions?: TaskActionRetryStartOptions;
}

export interface TaskActionSurfaceModel {
  readonly taskId: string;
  readonly action: string;
  readonly generation?: number;
  readonly retryStartOptions: readonly TaskActionRetryOption[];
  readonly selectedOptionId?: string;
  readonly canFinalizeRetry: boolean;
  readonly finalizationState: TaskActionFinalizationState;
  readonly snapshot: {
    readonly taskId: string;
    readonly status?: string;
    readonly latestRun?: string;
    readonly branch?: string;
    readonly workflow?: string;
  };
}

export type TaskActionFinalizationState = 'active' | 'finalizing' | 'accepted' | 'failed';

export function taskActionFinalizationState(
  surface: { readonly finalizationState: TaskActionFinalizationState } | null | undefined,
): TaskActionFinalizationState | null;

export function taskActionSurfaceWithState<T extends object>(
  surface: T | null | undefined,
  finalizationState: TaskActionFinalizationState,
): (T & { readonly finalizationState: TaskActionFinalizationState }) | null;

export function taskActionCanRestart(
  surface: { readonly finalizationState: TaskActionFinalizationState } | null | undefined,
): boolean;

export function taskActionSurfaceModel(
  session: {
    readonly id?: string;
    readonly workflow?: string;
    readonly mode?: string;
    readonly intro?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly taskAction?: TaskActionReference | null;
  } | null | undefined,
  task?: {
    readonly taskId?: string;
    readonly status?: string;
    readonly workflow?: string;
    readonly branch?: string;
    readonly runs?: readonly { readonly slug?: string }[];
  } | null,
): TaskActionSurfaceModel | null;

export interface TaskActionGoState {
  readonly goCommand: boolean;
  readonly canSubmit: boolean;
  readonly taskActionOptionId?: string;
  readonly reasonKey?: string;
}

export function taskActionGoState(
  surface: {
    readonly action: string;
    readonly canFinalizeRetry: boolean;
    readonly selectedOptionId?: string;
    readonly finalizationState: TaskActionFinalizationState;
  } | null | undefined,
  text: string,
): TaskActionGoState;

export type TaskInstructionRoute =
  | { readonly kind: 'new-task'; readonly task: string }
  | {
      readonly kind: 'task-action';
      readonly task: string;
      readonly taskAction: TaskActionReplyReference;
      readonly taskActionOptionId?: string;
    }
  | { readonly kind: 'invalid' };

export type TaskActionReplyReference = TaskActionReference;

export function taskInstructionRoute(
  session: { readonly taskAction?: TaskActionReference | null } | null | undefined,
  reply: {
    readonly kind: string;
    readonly task: string;
    readonly taskAction?: TaskActionReplyReference;
    readonly taskActionOptionId?: string;
  } | null | undefined,
): TaskInstructionRoute | null;

export function buildTaskActionRequest(
  projectId: string,
  taskId: string,
  action: string,
  input?: string,
  conversationId?: string,
  taskActionOptionId?: string,
): TaskActionRequest;

export interface TaskActionDialogModel {
  readonly titleId: string;
  readonly titleKey: string;
  readonly statusKey: string;
  readonly taskStatusKey?: string;
  readonly diff?: string;
  readonly prUrl?: string;
}

export function buildTaskActionDialogModel(
  result: {
    readonly action: string;
    readonly status: string;
    readonly taskStatus?: string;
    readonly diff?: unknown;
    readonly prUrl?: unknown;
  },
  sequence: number,
): TaskActionDialogModel;
