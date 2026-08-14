import type { AgentResponse } from '../../models/index.js';
import type { CompanionFinding } from '../../models/companion-types.js';
import {
  MODERATOR_OUTPUT_JSON_SCHEMA,
  REVIEW_OUTPUT_JSON_SCHEMA,
  parseCompanionReviewOutput,
  parseModeratorOutput,
  type CompanionReviewOutput,
} from './contracts.js';
import type { CompanionDiff } from './diff-reader.js';
import type { CompanionLoopRound } from './loop-guard.js';
import {
  moderateCompanionResult,
  validateModeratorDecisions,
  type ModeratorResult,
} from './moderator.js';
import {
  buildCompanionModeratorPrompt,
  buildCompanionReviewPrompt,
} from './prompt.js';
import type {
  CompanionAgentPurpose,
  CompanionStructuredResponseValidator,
} from './review-runner.js';
import type {
  CompanionReviewAuditSnapshot,
  CompanionReviewStateStore,
} from './review-state-store.js';
import type { CompanionReviewOperation } from './review-state-store.js';
import type { CompanionLoopDecision } from './terminal-decision.js';
import type { CompanionReviewRequest } from './review-queue.js';

const MAX_OPEN_MUST_FIX = 5;

interface CompanionReviewRoundInput {
  readonly companionName: string;
  readonly diff: CompanionDiff;
  readonly trigger: CompanionReviewRequest['reason'];
  readonly observedGeneration: number;
  readonly changedRegionsSincePreviousReview: readonly string[];
  readonly diffSummary: string;
  readonly implementerExplanation?: string;
  readonly signal: AbortSignal;
  readonly task: string;
  readonly stepName: string;
  readonly activeNames: readonly string[];
  readonly moderatorName?: string;
  readonly stateStore: CompanionReviewStateStore;
  readonly mailboxPath: (name: string) => string;
  readonly systemPrompt: (name: string) => string;
  readonly openFindings: () => CompanionFinding[];
  readonly callStructured: (
    purpose: CompanionAgentPurpose,
    agentName: string,
    systemPrompt: string,
    prompt: string,
    outputSchema: Record<string, unknown>,
    signal: AbortSignal,
    validateResponse?: CompanionStructuredResponseValidator,
  ) => Promise<AgentResponse>;
  readonly emitFinding: (
    companionName: string,
    findingId: string,
    severity: 'must_fix' | 'should_fix' | 'nit',
  ) => void;
  readonly markReviewed: (snapshot: CompanionDiff, observedGeneration: number) => void;
  readonly evaluateRound: (
    digest: string,
    diffSummary: string,
    implementerExplanation: string | undefined,
    transitions: CompanionLoopRound['transitions'],
  ) => Promise<{
    historyScope: string;
    round: CompanionLoopRound;
    decision: CompanionLoopDecision;
  }>;
  readonly applyRoundDecision: (decision: CompanionLoopDecision) => void;
  readonly onRoundCompleted: (round: {
    readonly snapshot: CompanionDiff;
    readonly trigger: CompanionReviewRequest['reason'];
    readonly findingCount: number;
    readonly reviewerResult: CompanionReviewOutput;
    readonly moderator?: {
      readonly name: string;
      readonly invoked: boolean;
      readonly reason?: 'reviewer_result_empty' | 'not_configured';
      readonly result?: ModeratorResult;
    };
    readonly accepted: CompanionReviewOutput;
    readonly zeroReason?:
      | 'reviewer_returned_no_findings'
      | 'moderator_not_invoked_for_empty_reviewer_result'
      | 'moderator_rejected_or_merged_all_findings'
      | 'no_new_finding_records';
  }) => void;
}

export interface CompanionReviewRoundResult {
  readonly findingCount: number;
}

export async function executeCompanionReviewRound(
  input: CompanionReviewRoundInput,
): Promise<CompanionReviewRoundResult> {
  input.signal.throwIfAborted();
  const mailboxPath = input.mailboxPath(input.companionName);
  const pending = input.stateStore.getPendingOperation(mailboxPath);
  if (pending !== undefined) {
    const findingCount = await commitOperation(input, pending);
    await finalizeOperation(input, mailboxPath);
    const audit = pending.audit ?? reconstructAuditSnapshot(pending);
    const zeroReason = resolveZeroReason({
      reviewerResult: audit.reviewerResult,
      moderatorAudit: audit.moderator,
      accepted: audit.accepted,
      findingCount,
    });
    input.onRoundCompleted({
      snapshot: pending.snapshot,
      trigger: pending.trigger,
      reviewerResult: audit.reviewerResult,
      ...(audit.moderator === undefined ? {} : { moderator: audit.moderator }),
      accepted: audit.accepted,
      findingCount,
      ...(zeroReason === undefined ? {} : { zeroReason }),
    });
    if (
      pending.snapshot.digest === input.diff.digest
      && pending.observedGeneration === input.observedGeneration
    ) {
      return { findingCount };
    }
  }
  const state = input.stateStore.get(mailboxPath, input.companionName);
  const ownersByFindingId = buildFindingOwnerIndex(input);
  const response = await input.callStructured(
    'reviewer',
    input.companionName,
    input.systemPrompt(input.companionName),
    buildCompanionReviewPrompt({
      companionName: input.companionName,
      task: input.task,
      stepName: input.stepName,
      cumulativeDiff: input.diff.content,
      changedSincePreviousReview: input.changedRegionsSincePreviousReview,
      diffSummary: input.diffSummary,
      implementerExplanation: input.implementerExplanation,
      findings: state.mailbox.findings,
      notes: state.notes,
    }),
    REVIEW_OUTPUT_JSON_SCHEMA,
    input.signal,
    (candidate) => {
      const reviewerResult = parseCompanionReviewOutput(candidate.structuredOutput);
      if (input.moderatorName === undefined) {
        validateUpdates(input, reviewerResult.updates, ownersByFindingId);
      }
    },
  );
  input.signal.throwIfAborted();
  const reviewerResult = parseCompanionReviewOutput(response.structuredOutput);
  let findingCount = 0;
  let accepted: CompanionReviewOutput = { findings: [], updates: [] };
  let moderatorAudit: {
    readonly name: string;
    readonly invoked: boolean;
    readonly reason?: 'reviewer_result_empty' | 'not_configured';
    readonly result?: ModeratorResult;
  } | undefined;
  let pendingCommitAudit: CompanionReviewAuditSnapshot | undefined;
  const commit = createCommit(input, mailboxPath, (count) => {
    findingCount = count;
  }, () => pendingCommitAudit);
  const moderatorName = input.moderatorName;

  if (moderatorName === undefined) {
    moderatorAudit = { name: 'not-configured', invoked: false, reason: 'not_configured' };
    accepted = reviewerResult;
    await commit(reviewerResult, {
      reviewerResult,
      accepted: reviewerResult,
      moderator: moderatorAudit,
    });
  } else {
    const openFindings = input.openFindings();
    const moderated = await moderateCompanionResult({
      reviewerResult,
      openFindings,
      diffSummary: input.diffSummary,
      implementerExplanation: input.implementerExplanation,
      runModerator: async (request) => {
        const moderated = await input.callStructured(
          'moderator',
          moderatorName,
          input.systemPrompt(moderatorName),
          buildCompanionModeratorPrompt(request),
          MODERATOR_OUTPUT_JSON_SCHEMA,
          input.signal,
          (candidate) => {
            const moderated = parseModeratorOutput(candidate.structuredOutput);
            validateModeratorDecisions(moderated, reviewerResult, openFindings);
            validateUpdates(input, moderated.updates, ownersByFindingId);
          },
        );
        input.signal.throwIfAborted();
        return parseModeratorOutput(moderated.structuredOutput);
      },
      moderatorName,
      commit,
      onCommitAudit: (audit) => {
        pendingCommitAudit = audit;
      },
    });
    if (moderated === undefined) {
      moderatorAudit = {
        name: moderatorName,
        invoked: false,
        reason: 'reviewer_result_empty',
      };
      accepted = reviewerResult.notes === undefined
        ? { findings: [], updates: [] }
        : { findings: [], updates: [], notes: reviewerResult.notes };
      pendingCommitAudit = {
        reviewerResult,
        accepted,
        moderator: moderatorAudit,
      };
    } else {
      moderatorAudit = { name: moderatorName, invoked: true, result: moderated.moderator };
      accepted = moderated.accepted;
    }
  }
  if (input.stateStore.getPendingOperation(mailboxPath) === undefined) {
    await commit({ findings: [], updates: [] });
  }
  await finalizeOperation(input, mailboxPath);
  const zeroReason = resolveZeroReason({
    reviewerResult,
    moderatorAudit,
    accepted,
    findingCount,
  });
  input.onRoundCompleted({
    snapshot: input.diff,
    trigger: input.trigger,
    reviewerResult,
    ...(moderatorAudit === undefined ? {} : { moderator: moderatorAudit }),
    accepted,
    findingCount,
    ...(zeroReason === undefined ? {} : { zeroReason }),
  });
  return { findingCount };
}

function resolveZeroReason(input: {
  readonly reviewerResult: CompanionReviewOutput;
  readonly moderatorAudit?: {
    readonly name: string;
    readonly invoked: boolean;
    readonly reason?: 'reviewer_result_empty' | 'not_configured';
  };
  readonly accepted: CompanionReviewOutput;
  readonly findingCount: number;
}):
  | 'reviewer_returned_no_findings'
  | 'moderator_not_invoked_for_empty_reviewer_result'
  | 'moderator_rejected_or_merged_all_findings'
  | 'no_new_finding_records'
  | undefined {
  if (input.findingCount !== 0) return undefined;
  if (input.reviewerResult.findings.length === 0) {
    return input.moderatorAudit?.reason === 'reviewer_result_empty'
      ? 'moderator_not_invoked_for_empty_reviewer_result'
      : 'reviewer_returned_no_findings';
  }
  if (
    input.moderatorAudit?.invoked === true
    && input.accepted.findings.length === 0
  ) {
    return 'moderator_rejected_or_merged_all_findings';
  }
  return 'no_new_finding_records';
}

function reconstructAuditSnapshot(operation: CompanionReviewOperation): CompanionReviewAuditSnapshot {
  const result = operation.owners.reduce<CompanionReviewOutput>(
    (combined, owner) => ({
      findings: [...combined.findings, ...owner.result.findings],
      updates: [...combined.updates, ...owner.result.updates],
      ...(combined.notes === undefined && owner.result.notes === undefined
        ? {}
        : { notes: owner.result.notes ?? combined.notes }),
    }),
    { findings: [], updates: [] },
  );
  return { reviewerResult: result, accepted: result };
}

function createCommit(
  input: CompanionReviewRoundInput,
  scope: string,
  onFindingCount: (count: number) => void,
  getAudit: () => CompanionReviewAuditSnapshot | undefined = () => undefined,
): (
  accepted: CompanionReviewOutput,
  audit?: CompanionReviewAuditSnapshot,
) => Promise<void> {
  return async (accepted, audit) => {
    input.signal.throwIfAborted();
    const ownersByFindingId = buildFindingOwnerIndex(input);
    validateUpdates(input, accepted.updates, ownersByFindingId);
    const owners = input.activeNames.flatMap((ownerName) => {
      const result = resultForOwner(
        input.companionName,
        ownerName,
        accepted,
        ownersByFindingId,
      );
      return hasStateChange(result)
        ? [{ ownerName, path: input.mailboxPath(ownerName), result }]
        : [];
    });
    const committedAudit = audit ?? getAudit();
    input.stateStore.beginOperation({
      scope,
      snapshot: input.diff,
      trigger: input.trigger,
      observedGeneration: input.observedGeneration,
      diffSummary: input.diffSummary,
      ...(input.implementerExplanation === undefined
        ? {}
        : { implementerExplanation: input.implementerExplanation }),
      owners,
      ...(committedAudit === undefined ? {} : { audit: committedAudit }),
    });
    const operation = input.stateStore.getPendingOperation(scope);
    if (operation === undefined) {
      throw new Error(`Companion review operation was not created: ${scope}`);
    }
    onFindingCount(await commitOperation(input, operation));
  };
}

async function commitOperation(
  input: CompanionReviewRoundInput,
  operation: CompanionReviewOperation,
): Promise<number> {
  let findingCount = operation.findingEvents.length;
  publishPendingFindingEvents(input, operation.scope);
  for (const owner of operation.owners) {
    const current = input.stateStore.getPendingOperation(operation.scope);
    if (current === undefined) {
      throw new Error(`Companion review operation is not pending: ${operation.scope}`);
    }
    if (current.completedOwners.has(owner.ownerName)) continue;
    input.signal.throwIfAborted();
    const transitions = collectTransitions(
      input.stateStore,
      owner.path,
      owner.ownerName,
      owner.result,
    );
    findingCount += input.stateStore.applyOwner(operation.scope, owner.ownerName, transitions, {
      path: owner.path,
      companionName: owner.ownerName,
      maxOpenMustFix: MAX_OPEN_MUST_FIX,
      result: owner.result,
    });
    publishPendingFindingEvents(input, operation.scope);
  }
  return findingCount;
}

function publishPendingFindingEvents(
  input: CompanionReviewRoundInput,
  scope: string,
): void {
  while (true) {
    input.signal.throwIfAborted();
    const event = input.stateStore.takeNextFindingEvent(scope);
    if (event === undefined) return;
    input.emitFinding(event.companionName, event.findingId, event.severity);
  }
}

async function finalizeOperation(
  input: CompanionReviewRoundInput,
  scope: string,
): Promise<void> {
  input.signal.throwIfAborted();
  const operation = input.stateStore.getPendingOperation(scope);
  if (operation === undefined) {
    throw new Error(`Companion review operation is not pending: ${scope}`);
  }
  if (operation.roundDecision === undefined) {
    const evaluated = await input.evaluateRound(
      operation.snapshot.digest,
      operation.diffSummary,
      operation.implementerExplanation,
      operation.transitions,
    );
    input.stateStore.completeRound(
      scope,
      evaluated.historyScope,
      evaluated.round,
      evaluated.decision,
    );
  }
  const completed = input.stateStore.getPendingOperation(scope);
  if (completed?.roundDecision === undefined) {
    throw new Error(`Companion review round was not committed: ${scope}`);
  }
  input.applyRoundDecision(completed.roundDecision);
  input.signal.throwIfAborted();
  input.markReviewed(completed.snapshot, completed.observedGeneration);
  input.stateStore.completeOperation(scope);
}

function hasStateChange(result: CompanionReviewOutput): boolean {
  return result.findings.length > 0 || result.updates.length > 0 || result.notes !== undefined;
}

function validateUpdates(
  input: CompanionReviewRoundInput,
  updates: CompanionReviewOutput['updates'],
  ownersByFindingId: ReadonlyMap<string, string>,
): void {
  for (const update of updates) {
    const ownerName = ownersByFindingId.get(update.id);
    if (ownerName === undefined) {
      const actor = input.moderatorName === undefined
        ? `Companion "${input.companionName}"`
        : `Moderator "${input.moderatorName}"`;
      throw new Error(`${actor} references unknown companion finding "${update.id}"`);
    }
    if (input.moderatorName === undefined && ownerName !== input.companionName) {
      throw new Error(
        `Companion "${input.companionName}" cannot update finding "${update.id}"`,
      );
    }
  }
}

function buildFindingOwnerIndex(input: CompanionReviewRoundInput): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  for (const ownerName of input.activeNames) {
    for (const finding of input.stateStore.get(
      input.mailboxPath(ownerName),
      ownerName,
    ).mailbox.findings) {
      const existing = owners.get(finding.id);
      if (existing !== undefined) {
        throw new Error(
          `Companion finding "${finding.id}" has multiple owners: "${existing}" and "${ownerName}"`,
        );
      }
      owners.set(finding.id, ownerName);
    }
  }
  return owners;
}

function resultForOwner(
  reviewerName: string,
  ownerName: string,
  accepted: CompanionReviewOutput,
  ownersByFindingId: ReadonlyMap<string, string>,
): CompanionReviewOutput {
  return {
    findings: ownerName === reviewerName ? accepted.findings : [],
    updates: accepted.updates.filter(({ id }) => ownersByFindingId.get(id) === ownerName),
    ...(ownerName === reviewerName && accepted.notes !== undefined
      ? { notes: accepted.notes }
      : {}),
  };
}

function collectTransitions(
  stateStore: CompanionReviewStateStore,
  ownerPath: string,
  ownerName: string,
  ownerResult: CompanionReviewOutput,
): CompanionLoopRound['transitions'] {
  const transitions: CompanionLoopRound['transitions'][number][] = [];
  for (const update of ownerResult.updates) {
    const previous = stateStore.get(ownerPath, ownerName).mailbox.findings.find(
      ({ id }) => id === update.id,
    );
    if (previous !== undefined && previous.status !== update.status) {
      transitions.push({ id: update.id, from: previous.status, to: update.status });
    }
  }
  return transitions;
}
