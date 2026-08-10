import type { CompanionReviewOutput } from './contracts.js';
import type { CompanionDiff } from './diff-reader.js';
import {
  cloneCompanionLoopHistorySnapshot,
  createCompanionLoopHistorySnapshot,
  recordCompanionLoopRound,
  type CompanionLoopHistorySnapshot,
  type CompanionLoopRound,
} from './loop-guard.js';
import {
  applyCompanionReviewResult,
  loadCompanionMailboxState,
  type CompanionMailbox,
} from './mailbox.js';
import { appendCompanionMailboxRecords } from './mailbox-projection.js';
import type { CompanionLoopDecision } from './terminal-decision.js';
import type { CompanionReviewRequest } from './review-queue.js';

interface CompanionReviewState {
  mailbox: CompanionMailbox;
  deferred: CompanionReviewOutput['findings'];
  notes?: string;
  projection: string;
}

export interface CompanionReviewOwnerOperation {
  readonly ownerName: string;
  readonly path: string;
  readonly result: CompanionReviewOutput;
}

export interface CompanionReviewOperation {
  readonly scope: string;
  readonly snapshot: CompanionDiff;
  readonly trigger: CompanionReviewRequest['reason'];
  readonly observedGeneration: number;
  readonly diffSummary: string;
  readonly implementerExplanation?: string;
  readonly owners: readonly CompanionReviewOwnerOperation[];
  readonly completedOwners: ReadonlySet<string>;
  readonly transitions: CompanionLoopRound['transitions'];
  readonly findingEvents: readonly CompanionFindingEvent[];
  readonly attemptedFindingEvents: ReadonlySet<string>;
  readonly roundDecision?: CompanionLoopDecision;
}

export interface CompanionFindingEvent {
  readonly companionName: string;
  readonly findingId: string;
  readonly severity: 'must_fix' | 'should_fix' | 'nit';
}

interface CompanionReviewStateApplyInput {
  readonly path: string;
  readonly companionName: string;
  readonly maxOpenMustFix: number;
  readonly result: CompanionReviewOutput;
}

type CompanionReviewStateApplyResult = ReturnType<typeof applyCompanionReviewResult>;

interface PreparedCompanionReviewState {
  readonly applied: CompanionReviewStateApplyResult;
  readonly nextState: CompanionReviewState;
}

interface CompanionReviewAuthorityState {
  readonly states: Map<string, CompanionReviewState>;
  readonly histories: Map<string, CompanionLoopHistorySnapshot>;
  readonly operations: Map<string, CompanionReviewOperation>;
}

const authorityStates = new WeakMap<CompanionReviewAuthority, CompanionReviewAuthorityState>();

export class CompanionReviewAuthority {}

export interface CompanionMailboxRecordWriter {
  append(path: string, currentProjection: string, records: readonly object[]): string;
}

const DEFAULT_MAILBOX_WRITER: CompanionMailboxRecordWriter = {
  append: appendCompanionMailboxRecords,
};

export class CompanionReviewStateStore {
  private readonly shared: CompanionReviewAuthorityState;

  constructor(
    authority = new CompanionReviewAuthority(),
    private readonly writer: CompanionMailboxRecordWriter = DEFAULT_MAILBOX_WRITER,
  ) {
    this.shared = getAuthorityState(authority);
  }

  get(path: string, companionName: string): Readonly<CompanionReviewState> {
    return cloneState(this.getMutable(path, companionName));
  }

  apply(input: CompanionReviewStateApplyInput): CompanionReviewStateApplyResult {
    const prepared = this.prepare(input);
    this.persist(input, prepared);
    return cloneAppliedResult(prepared.applied);
  }

  private prepare(input: CompanionReviewStateApplyInput): PreparedCompanionReviewState {
    const current = this.getMutable(input.path, input.companionName);
    const applied = applyCompanionReviewResult({
      companionName: input.companionName,
      mailbox: current.mailbox,
      maxOpenMustFix: input.maxOpenMustFix,
      result: cloneReviewOutput({
        ...input.result,
        findings: [...current.deferred, ...input.result.findings],
      }),
    });
    const nextState: CompanionReviewState = {
      mailbox: cloneMailbox(applied.mailbox),
      deferred: applied.deferred.map((finding) => ({ ...finding })),
      ...(input.result.notes === undefined ? current.notes === undefined ? {} : { notes: current.notes } : {
        notes: input.result.notes,
      }),
      projection: current.projection,
    };
    return { applied, nextState };
  }

  private persist(
    input: CompanionReviewStateApplyInput,
    prepared: PreparedCompanionReviewState,
  ): void {
    const projection = this.writer.append(
      input.path,
      this.getMutable(input.path, input.companionName).projection,
      prepared.applied.records,
    );
    this.shared.states.set(input.path, { ...prepared.nextState, projection });
  }

  getPendingOperation(scope: string): CompanionReviewOperation | undefined {
    const operation = this.shared.operations.get(scope);
    return operation === undefined ? undefined : cloneOperation(operation);
  }

  beginOperation(operation: Omit<CompanionReviewOperation,
    'completedOwners' | 'transitions' | 'findingEvents' | 'attemptedFindingEvents' | 'roundDecision'
  >): void {
    if (this.shared.operations.has(operation.scope)) {
      throw new Error(`Companion review operation is already pending: ${operation.scope}`);
    }
    this.shared.operations.set(operation.scope, {
      ...cloneOperationInput(operation),
      completedOwners: new Set(),
      transitions: [],
      findingEvents: [],
      attemptedFindingEvents: new Set(),
    });
  }

  applyOwner(
    scope: string,
    ownerName: string,
    transitions: CompanionLoopRound['transitions'],
    input: CompanionReviewStateApplyInput,
  ): number {
    const operation = this.requireOperation(scope);
    const owner = operation.owners.find((candidate) => candidate.ownerName === ownerName);
    if (
      owner === undefined
      || owner.path !== input.path
      || owner.ownerName !== input.companionName
    ) {
      throw new Error(`Companion review owner does not match its pending operation: ${ownerName}`);
    }
    if (operation.completedOwners.has(ownerName)) {
      throw new Error(`Companion review owner is already committed: ${ownerName}`);
    }
    const prepared = this.prepare(input);
    const findingEvents = prepared.applied.records.flatMap((record) => (
      'severity' in record
        ? [{
            companionName: ownerName,
            findingId: record.id,
            severity: record.severity,
          }]
        : []
    ));
    this.persist(input, prepared);
    this.shared.operations.set(scope, {
      ...operation,
      completedOwners: new Set([...operation.completedOwners, ownerName]),
      transitions: [
        ...operation.transitions.map((transition) => ({ ...transition })),
        ...transitions.map((transition) => ({ ...transition })),
      ],
      findingEvents: [...operation.findingEvents, ...findingEvents],
    });
    return findingEvents.length;
  }

  takeNextFindingEvent(scope: string): CompanionFindingEvent | undefined {
    const operation = this.requireOperation(scope);
    const event = operation.findingEvents.find(
      ({ findingId }) => !operation.attemptedFindingEvents.has(findingId),
    );
    if (event === undefined) return undefined;
    this.shared.operations.set(scope, {
      ...operation,
      attemptedFindingEvents: new Set([
        ...operation.attemptedFindingEvents,
        event.findingId,
      ]),
    });
    return { ...event };
  }

  previewRound(scope: string, round: CompanionLoopRound): CompanionLoopHistorySnapshot {
    return cloneCompanionLoopHistorySnapshot(this.nextHistory(scope, round));
  }

  completeRound(
    operationScope: string,
    historyScope: string,
    round: CompanionLoopRound,
    decision: CompanionLoopDecision,
  ): void {
    const operation = this.requireOperation(operationScope);
    if (operation.roundDecision !== undefined) {
      throw new Error(`Companion review round is already committed: ${operationScope}`);
    }
    const history = this.nextHistory(historyScope, round);
    this.shared.histories.set(historyScope, history);
    this.shared.operations.set(operationScope, {
      ...operation,
      roundDecision: cloneDecision(decision),
    });
  }

  completeOperation(scope: string): void {
    const operation = this.requireOperation(scope);
    if (operation.completedOwners.size !== operation.owners.length) {
      throw new Error(`Companion review operation has unfinished owners: ${scope}`);
    }
    if (operation.roundDecision === undefined) {
      throw new Error(`Companion review operation has no committed round: ${scope}`);
    }
    this.shared.operations.delete(scope);
  }

  recordRound(scope: string, round: CompanionLoopRound): CompanionLoopHistorySnapshot {
    const history = this.nextHistory(scope, round);
    this.shared.histories.set(scope, history);
    return cloneCompanionLoopHistorySnapshot(history);
  }

  private nextHistory(scope: string, round: CompanionLoopRound): CompanionLoopHistorySnapshot {
    return recordCompanionLoopRound(
      this.shared.histories.get(scope) ?? createCompanionLoopHistorySnapshot(),
      round,
    );
  }

  private getMutable(path: string, companionName: string): CompanionReviewState {
    const existing = this.shared.states.get(path);
    if (existing !== undefined) {
      if (existing.mailbox.companionName !== companionName) {
        throw new Error(
          `Companion review state path is already owned by "${existing.mailbox.companionName}": ${path}`,
        );
      }
      return existing;
    }
    const created = loadState(path, companionName);
    this.shared.states.set(path, created);
    return created;
  }

  private requireOperation(scope: string): CompanionReviewOperation {
    const operation = this.shared.operations.get(scope);
    if (operation === undefined) {
      throw new Error(`Companion review operation is not pending: ${scope}`);
    }
    return operation;
  }
}

function loadState(path: string, companionName: string): CompanionReviewState {
  const loaded = loadCompanionMailboxState(path, companionName);
  return {
    mailbox: loaded.mailbox,
    deferred: [],
    projection: loaded.projection,
  };
}

function cloneState(state: CompanionReviewState): CompanionReviewState {
  return {
    mailbox: cloneMailbox(state.mailbox),
    deferred: state.deferred.map((finding) => ({ ...finding })),
    ...(state.notes === undefined ? {} : { notes: state.notes }),
    projection: state.projection,
  };
}

function cloneMailbox(mailbox: CompanionMailbox): CompanionMailbox {
  return {
    companionName: mailbox.companionName,
    findings: mailbox.findings.map((finding) => ({ ...finding })),
    openMustFixCount: mailbox.openMustFixCount,
    nextSequence: mailbox.nextSequence,
  };
}

function cloneReviewOutput(output: CompanionReviewOutput): CompanionReviewOutput {
  return {
    findings: output.findings.map((finding) => ({ ...finding })),
    updates: output.updates.map((update) => ({ ...update })),
    ...(output.notes === undefined ? {} : { notes: output.notes }),
  };
}

function cloneAppliedResult(
  applied: ReturnType<typeof applyCompanionReviewResult>,
): ReturnType<typeof applyCompanionReviewResult> {
  return {
    mailbox: cloneMailbox(applied.mailbox),
    records: applied.records.map((record) => ({ ...record })),
    deferred: applied.deferred.map((finding) => ({ ...finding })),
  };
}

function cloneOperationInput(
  operation: Omit<CompanionReviewOperation,
    'completedOwners' | 'transitions' | 'findingEvents' | 'attemptedFindingEvents' | 'roundDecision'
  >,
): Omit<CompanionReviewOperation,
  'completedOwners' | 'transitions' | 'findingEvents' | 'attemptedFindingEvents' | 'roundDecision'
> {
  return {
    scope: operation.scope,
    snapshot: cloneDiff(operation.snapshot),
    trigger: operation.trigger,
    observedGeneration: operation.observedGeneration,
    diffSummary: operation.diffSummary,
    ...(operation.implementerExplanation === undefined
      ? {}
      : { implementerExplanation: operation.implementerExplanation }),
    owners: operation.owners.map((owner) => ({
      ownerName: owner.ownerName,
      path: owner.path,
      result: cloneReviewOutput(owner.result),
    })),
  };
}

function cloneOperation(operation: CompanionReviewOperation): CompanionReviewOperation {
  return {
    ...cloneOperationInput(operation),
    completedOwners: new Set(operation.completedOwners),
    transitions: operation.transitions.map((transition) => ({ ...transition })),
    findingEvents: operation.findingEvents.map((event) => ({ ...event })),
    attemptedFindingEvents: new Set(operation.attemptedFindingEvents),
    ...(operation.roundDecision === undefined
      ? {}
      : { roundDecision: cloneDecision(operation.roundDecision) }),
  };
}

function getAuthorityState(authority: CompanionReviewAuthority): CompanionReviewAuthorityState {
  const existing = authorityStates.get(authority);
  if (existing !== undefined) return existing;
  const created = {
    states: new Map<string, CompanionReviewState>(),
    histories: new Map<string, CompanionLoopHistorySnapshot>(),
    operations: new Map<string, CompanionReviewOperation>(),
  };
  authorityStates.set(authority, created);
  return created;
}

function cloneDecision(decision: CompanionLoopDecision): CompanionLoopDecision {
  return {
    decision: decision.decision,
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
  };
}

function cloneDiff(diff: CompanionDiff): CompanionDiff {
  return {
    ...diff,
    changedFiles: [...diff.changedFiles],
    fileFingerprints: { ...diff.fileFingerprints },
    hunkFingerprints: { ...diff.hunkFingerprints },
  };
}
