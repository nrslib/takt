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
import { moderateCompanionResult } from './moderator.js';
import {
  buildCompanionModeratorPrompt,
  buildCompanionReviewPrompt,
} from './prompt.js';
import type { CompanionAgentPurpose } from './review-runner.js';
import type { CompanionReviewStateStore } from './review-state-store.js';
import type { CompanionReviewOperation } from './review-state-store.js';
import type { CompanionLoopDecision } from './terminal-decision.js';

const MAX_OPEN_MUST_FIX = 5;

interface CompanionReviewRoundInput {
  readonly companionName: string;
  readonly diff: CompanionDiff;
  readonly observedGeneration: number;
  readonly changedRegionsSincePreviousReview: readonly string[];
  readonly diffSummary: string;
  readonly implementerExplanation?: string;
  readonly signal: AbortSignal;
  readonly task: string;
  readonly stepName: string;
  readonly stepInstruction: string;
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
}

export async function executeCompanionReviewRound(
  input: CompanionReviewRoundInput,
): Promise<void> {
  input.signal.throwIfAborted();
  const mailboxPath = input.mailboxPath(input.companionName);
  const pending = input.stateStore.getPendingOperation(mailboxPath);
  if (pending !== undefined) {
    await commitOperation(input, pending);
    await finalizeOperation(input, mailboxPath);
    if (
      pending.snapshot.digest === input.diff.digest
      && pending.observedGeneration === input.observedGeneration
    ) {
      return;
    }
  }
  const state = input.stateStore.get(mailboxPath, input.companionName);
  const response = await input.callStructured(
    'reviewer',
    input.companionName,
    input.systemPrompt(input.companionName),
    buildCompanionReviewPrompt({
      companionName: input.companionName,
      task: input.task,
      stepName: input.stepName,
      stepInstruction: input.stepInstruction,
      cumulativeDiff: input.diff.content,
      changedSincePreviousReview: input.changedRegionsSincePreviousReview,
      diffSummary: input.diffSummary,
      implementerExplanation: input.implementerExplanation,
      findings: state.mailbox.findings,
      notes: state.notes,
    }),
    REVIEW_OUTPUT_JSON_SCHEMA,
    input.signal,
  );
  input.signal.throwIfAborted();
  const reviewerResult = parseCompanionReviewOutput(response.structuredOutput);
  const commit = createCommit(input, mailboxPath);
  const moderatorName = input.moderatorName;

  if (moderatorName === undefined) {
    await commit(reviewerResult);
  } else {
    await moderateCompanionResult({
      reviewerResult,
      openFindings: input.openFindings(),
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
        );
        input.signal.throwIfAborted();
        return parseModeratorOutput(moderated.structuredOutput);
      },
      commit,
    });
  }
  if (input.stateStore.getPendingOperation(mailboxPath) === undefined) {
    await commit({ findings: [], updates: [] });
  }
  await finalizeOperation(input, mailboxPath);
}

function createCommit(
  input: CompanionReviewRoundInput,
  scope: string,
): (accepted: CompanionReviewOutput) => Promise<void> {
  return async (accepted) => {
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
    input.stateStore.beginOperation({
      scope,
      snapshot: input.diff,
      observedGeneration: input.observedGeneration,
      diffSummary: input.diffSummary,
      ...(input.implementerExplanation === undefined
        ? {}
        : { implementerExplanation: input.implementerExplanation }),
      owners,
    });
    const operation = input.stateStore.getPendingOperation(scope);
    if (operation === undefined) {
      throw new Error(`Companion review operation was not created: ${scope}`);
    }
    await commitOperation(input, operation);
  };
}

async function commitOperation(
  input: CompanionReviewRoundInput,
  operation: CompanionReviewOperation,
): Promise<void> {
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
    input.stateStore.applyOwner(operation.scope, owner.ownerName, transitions, {
      path: owner.path,
      companionName: owner.ownerName,
      maxOpenMustFix: MAX_OPEN_MUST_FIX,
      result: owner.result,
    });
    publishPendingFindingEvents(input, operation.scope);
  }
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
      throw new Error(`Moderator references unknown companion finding "${update.id}"`);
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
