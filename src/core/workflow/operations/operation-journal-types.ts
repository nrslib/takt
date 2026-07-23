export type OperationJournalJsonValue =
  | string
  | number
  | boolean
  | null
  | OperationJournalJsonValue[]
  | { [key: string]: OperationJournalJsonValue };

export const OPERATION_JOURNAL_STAGES = Object.freeze([
  'reserved',
  'request_started',
  'worker_started',
  'running',
  'accepted',
  'applied',
  'terminating',
  'completed',
  'terminated',
] as const);

export type OperationJournalStage = (typeof OPERATION_JOURNAL_STAGES)[number];

export const OPERATION_JOURNAL_STAGE_ORDER: Readonly<Record<OperationJournalStage, number>> = Object.freeze({
  reserved: 0,
  request_started: 1,
  worker_started: 2,
  running: 3,
  accepted: 4,
  applied: 5,
  terminating: 6,
  completed: 7,
  terminated: 8,
});

export const OPERATION_ATTEMPT_STATUSES = Object.freeze([
  'started',
  'accepted',
  'rejected',
  'terminated',
  'late',
] as const);

export type OperationAttemptStatus = (typeof OPERATION_ATTEMPT_STATUSES)[number];

export interface OperationOwner {
  readonly generation: number;
  readonly claimToken: string;
}

export interface OperationAttemptRecord {
  readonly id: string;
  readonly attemptToken: string;
  readonly sequence: number;
  readonly status: OperationAttemptStatus;
  readonly payload: OperationJournalJsonValue;
}

export interface OperationJournalChild {
  readonly id: string;
  readonly kind: string;
  readonly revision: number;
  readonly stage: OperationJournalStage;
  readonly payload: OperationJournalJsonValue;
  readonly attempts: readonly OperationAttemptRecord[];
}

export interface OperationJournalParent {
  readonly id: string;
  readonly kind: string;
  readonly revision: number;
  readonly stage: OperationJournalStage;
  readonly payload: OperationJournalJsonValue;
  readonly owner: OperationOwner;
  readonly children: readonly OperationJournalChild[];
}

export interface OperationJournalDocument {
  readonly version: 1;
  readonly parents: readonly OperationJournalParent[];
}

export interface CreateOperationParentInput {
  readonly id: string;
  readonly kind: string;
  readonly claimToken: string;
  readonly stage: OperationJournalStage;
  readonly payload: OperationJournalJsonValue;
}

export interface ClaimOperationParentInput {
  readonly parentId: string;
  readonly expectedOwner: OperationOwner;
  readonly expectedRevision: number;
  readonly expectedStage: OperationJournalStage;
  readonly nextClaimToken: string;
}

export interface CompareAndSetOperationParentInput {
  readonly parentId: string;
  readonly owner: OperationOwner;
  readonly expectedRevision: number;
  readonly expectedStage: OperationJournalStage;
  readonly nextStage: OperationJournalStage;
  readonly payload: OperationJournalJsonValue;
}

export interface CreateOperationChildInput {
  readonly parentId: string;
  readonly owner: OperationOwner;
  readonly expectedParentRevision: number;
  readonly expectedParentStage: OperationJournalStage;
  readonly id: string;
  readonly kind: string;
  readonly stage: OperationJournalStage;
  readonly payload: OperationJournalJsonValue;
}

export interface CompareAndSetOperationChildInput {
  readonly parentId: string;
  readonly owner: OperationOwner;
  readonly expectedParentRevision: number;
  readonly expectedParentStage: OperationJournalStage;
  readonly childId: string;
  readonly expectedRevision: number;
  readonly expectedStage: OperationJournalStage;
  readonly nextStage: OperationJournalStage;
  readonly payload: OperationJournalJsonValue;
}

export interface AppendOperationAttemptInput {
  readonly parentId: string;
  readonly owner: OperationOwner;
  readonly expectedParentRevision: number;
  readonly expectedParentStage: OperationJournalStage;
  readonly childId: string;
  readonly expectedRevision: number;
  readonly expectedStage: OperationJournalStage;
  readonly nextStage: OperationJournalStage;
  readonly payload: OperationJournalJsonValue;
  readonly attempt: Omit<OperationAttemptRecord, 'sequence'>;
}

export interface OperationJournalStore {
  createParent(input: CreateOperationParentInput): OperationJournalParent;
  getParent(parentId: string): OperationJournalParent;
  listParents(): readonly OperationJournalParent[];
  claimParent(input: ClaimOperationParentInput): OperationJournalParent;
  compareAndSetParent(input: CompareAndSetOperationParentInput): OperationJournalParent;
  createChild(input: CreateOperationChildInput): OperationJournalChild;
  getChild(parentId: string, childId: string): OperationJournalChild;
  listChildren(parentId: string): readonly OperationJournalChild[];
  compareAndSetChild(input: CompareAndSetOperationChildInput): OperationJournalChild;
  appendAttempt(input: AppendOperationAttemptInput): OperationJournalChild;
}
