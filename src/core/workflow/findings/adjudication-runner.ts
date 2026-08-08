import { executeAgent } from '../../../agents/agent-usecases.js';
import type { AgentResponse, WorkflowState, WorkflowStep } from '../../models/types.js';
import type { ConflictAdjudicationProposal } from '../../models/finding-contract-types.js';
import type { OptionsBuilder } from '../engine/OptionsBuilder.js';
import type { StepExecutor } from '../engine/StepExecutor.js';
import type { RuntimeStepResolution, StepRunResult } from '../types.js';
import {
  selectConflictForAdjudication,
  type FindingConflictAdjudicationDisposition,
} from './adjudication-apply.js';
import {
  commitFindingConflictAdjudication,
  completeFailedConflictAdjudication,
} from './adjudication-commit.js';
import { renderConflictAdjudicationInstruction } from './adjudication-evidence.js';
import {
  buildFindingEvidenceSearchWindows,
  findingEvidenceAnchorLineFor,
} from './evidence-search.js';
import { captureReviewScopeProofSnapshot } from './snapshot.js';
import {
  freshConflictAdjudicationSnapshot,
  isActiveConflictUnadjudicated,
} from './conflict-adjudication-model.js';
import {
  dispatchFindingManagerProviderCall,
  responseUpperBound,
} from './finding-manager-provider-call.js';
import { reserveFindingConflictAdjudication } from './adjudication-reservation.js';
import { FINDING_CONFLICT_ADJUDICATION_RULE_INDEX } from './adjudication-step.js';
import { parseConflictAdjudicationProviderOutput } from './schemas.js';
import type { FindingAdjudicationStore } from './store.js';
import type { FindingLedger, FindingObservation } from './types.js';
import { composeFindingAdjudicationInstruction } from './adjudication-instruction.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';

export interface FindingConflictAdjudicationRunnerDeps {
  ledgerStore: FindingAdjudicationStore;
  optionsBuilder: Pick<OptionsBuilder, 'buildAgentOptions' | 'resolveStepProviderModel'>;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction' | 'normalizeStructuredOutput'>;
  getCwd: () => string;
  workflowName: string;
  analyticsWorkflowName: string;
  findingScopeIdentity: string;
  runId: string;
  refreshFindingsState: () => void;
  emitEvent: (event: string, ...args: unknown[]) => void;
  guidance?: string;
}

const DISPOSITION_RULE_INDEX: Record<FindingConflictAdjudicationDisposition, number> = {
  finding_closed: FINDING_CONFLICT_ADJUDICATION_RULE_INDEX.FINDING_CLOSED,
  actionable_fix: FINDING_CONFLICT_ADJUDICATION_RULE_INDEX.ACTIONABLE_FIX,
  unresolved: FINDING_CONFLICT_ADJUDICATION_RULE_INDEX.UNRESOLVED,
};

function response(input: {
  step: WorkflowStep;
  content: string;
  matchedRuleIndex: number;
  structuredOutput?: Record<string, unknown>;
}): AgentResponse {
  return {
    persona: input.step.personaDisplayName,
    status: 'done',
    content: input.content,
    matchedRuleIndex: input.matchedRuleIndex,
    timestamp: new Date(),
    ...(input.structuredOutput === undefined ? {} : { structuredOutput: input.structuredOutput }),
  };
}

function requestBytes(input: {
  step: WorkflowStep;
  phase1Instruction: string;
  agentOptions: ReturnType<OptionsBuilder['buildAgentOptions']>;
}): string {
  return JSON.stringify({
    persona: input.step.persona,
    provider: input.step.provider ?? null,
    model: input.step.model ?? null,
    phase1Instruction: input.phase1Instruction,
    structuredOutput: input.step.structuredOutput,
    tools: input.agentOptions.allowedTools ?? [],
    applicationTokenOptions: {
      internalSystemPrompt: input.agentOptions.internalSystemPrompt ?? null,
      maxTurns: input.agentOptions.maxTurns ?? null,
      model: input.agentOptions.model ?? null,
      provider: input.agentOptions.provider ?? null,
      providerOptions: input.agentOptions.providerOptions ?? null,
      resolvedModel: input.agentOptions.resolvedModel ?? null,
      resolvedProvider: input.agentOptions.resolvedProvider ?? null,
      resolvedProviderOptions: input.agentOptions.resolvedProviderOptions ?? null,
    },
  });
}

// A crash after WAL reservation leaves a started attempt that the normal
// unadjudicated predicate excludes; selecting the reserved call resumes it.
function reservedConflictAttempt(
  ledger: FindingLedger,
  conflictId: string,
): Extract<FindingLedger['conflictAdjudicationAttempts'][number], { stage: 'started' }> | undefined {
  return ledger.conflictAdjudicationAttempts.find((attempt) => (
    attempt.conflictId === conflictId
    && attempt.stage === 'started'
    && ledger.findingManagerProviderCalls.some((call) => (
      call.providerCallId === attempt.providerCallId
      && call.ownerAttemptId === attempt.attemptId
      && call.purpose === 'conflict_adjudication'
      && call.state === 'reserved'
    ))
  )) as Extract<FindingLedger['conflictAdjudicationAttempts'][number], { stage: 'started' }> | undefined;
}

function hasReservedConflictAttempt(ledger: FindingLedger, conflictId: string): boolean {
  return reservedConflictAttempt(ledger, conflictId) !== undefined;
}

function hasGroundingRetryCandidate(
  ledger: FindingLedger,
  conflictId: string,
): boolean {
  const conflict = ledger.conflicts.find((candidate) => candidate.id === conflictId);
  if (conflict === undefined || conflict.status !== 'active') {
    return false;
  }
  const snapshot = freshConflictAdjudicationSnapshot(ledger, conflictId);
  const episode = ledger.conflictAdjudicationEpisodes.find((candidate) => (
    candidate.conflictSnapshotId === snapshot.conflictSnapshotId
  ));
  if (episode === undefined) {
    return false;
  }
  const attempts = ledger.conflictAdjudicationAttempts.filter((attempt) => (
    attempt.episodeId === episode.episodeId
  ));
  return attempts.some((attempt) => (
    attempt.stage === 'completed'
    && attempt.attemptOrdinal === 1
    && attempt.result.kind === 'verification_undetermined'
  )) && !attempts.some((attempt) => attempt.attemptOrdinal === 2);
}

function conflictGroundingTarget(ledger: FindingLedger, conflictId: string): {
  targetPaths: string[];
  anchorLines: ReadonlyMap<string, number | undefined>;
} {
  const conflict = ledger.conflicts.find((candidate) => candidate.id === conflictId);
  if (conflict === undefined) {
    return { targetPaths: [], anchorLines: new Map() };
  }
  const findings = conflict.findingIds
    .map((findingId) => ledger.findings.find((finding) => finding.id === findingId))
    .filter((finding): finding is NonNullable<typeof finding> => finding !== undefined);
  const rawFindingIds = [...new Set([
    ...conflict.rawFindingIds,
    ...findings.flatMap((finding) => finding.rawFindingIds),
  ])].sort(compareBinaryStrings);
  const rawFindings = rawFindingIds
    .map((rawFindingId) => ledger.rawFindings.find((raw) => raw.rawFindingId === rawFindingId))
    .filter((raw): raw is NonNullable<typeof raw> => raw !== undefined);
  const targetPaths = new Set<string>();
  for (const target of [
    ...findings.map((finding) => finding.target),
    ...rawFindings.map((raw) => raw.target),
  ]) {
    if (target?.kind === 'code') {
      for (const path of target.paths) {
        targetPaths.add(path);
      }
    }
  }
  const anchorLines = new Map<string, number | undefined>();
  for (const path of targetPaths) {
    for (const raw of rawFindings) {
      const anchorLine = findingEvidenceAnchorLineFor(raw, path);
      if (anchorLine !== undefined) {
        anchorLines.set(path, anchorLine);
        break;
      }
    }
  }
  return {
    targetPaths: [...targetPaths].sort(compareBinaryStrings),
    anchorLines,
  };
}

export function createFindingConflictAdjudicationRunner(deps: FindingConflictAdjudicationRunnerDeps): {
  run: (step: WorkflowStep, state: WorkflowState, runtime?: RuntimeStepResolution) => Promise<StepRunResult>;
  getLastOriginStep: () => string | undefined;
} {
  let lastOriginStep: string | undefined;
  const finish = (state: WorkflowState, step: WorkflowStep, value: AgentResponse): AgentResponse => {
    state.stepOutputs.set(step.name, value);
    state.lastOutput = value;
    return value;
  };
  const run = async (
    step: WorkflowStep,
    state: WorkflowState,
    runtime?: RuntimeStepResolution,
  ): Promise<StepRunResult> => {
    const providerInfo = deps.optionsBuilder.resolveStepProviderModel(step, runtime);
    const observation: FindingObservation = {
      runId: deps.runId,
      stepName: step.name,
      timestamp: new Date().toISOString(),
    };
    lastOriginStep = state.previousStep !== undefined && state.previousStep !== step.name
      ? state.previousStep
      : undefined;
    const roundMarker = `${deps.runId}:${state.iteration}:${step.name}`;
    const noTarget = (ledger: FindingLedger, reason: string): StepRunResult => {
      const active = ledger.conflicts.some((candidate) => candidate.status === 'active');
      const value = response({
        step,
        content: reason,
        matchedRuleIndex: active
          ? FINDING_CONFLICT_ADJUDICATION_RULE_INDEX.UNRESOLVED
          : FINDING_CONFLICT_ADJUDICATION_RULE_INDEX.FINDING_CLOSED,
      });
      deps.refreshFindingsState();
      return { response: finish(state, step, value), instruction: '', providerInfo };
    };
    const runAttempt = async (groundingRequested: boolean): Promise<StepRunResult> => {
      const current = deps.ledgerStore.loadLedger();
      const conflict = selectConflictForAdjudication(
        current,
        (candidate) => (
          hasReservedConflictAttempt(current, candidate.id)
          || isActiveConflictUnadjudicated(current, candidate.id)
          || hasGroundingRetryCandidate(current, candidate.id)
        ),
      );
      if (conflict === undefined) {
        return noTarget(current, 'No conflict is eligible for adjudication.');
      }
      const snapshot = freshConflictAdjudicationSnapshot(current, conflict.id);
      const existingReserved = reservedConflictAttempt(current, conflict.id);
      const grounding = groundingRequested
        || existingReserved?.attemptOrdinal === 2
        || hasGroundingRetryCandidate(current, conflict.id);
      const groundingInstruction = grounding
        ? (() => {
            const reviewScopeSnapshot = captureReviewScopeProofSnapshot(deps.getCwd());
            const target = conflictGroundingTarget(current, conflict.id);
            const windows = buildFindingEvidenceSearchWindows({
              snapshot: reviewScopeSnapshot,
              targetPaths: target.targetPaths,
              anchorLines: target.anchorLines,
            });
            return renderConflictAdjudicationInstruction(snapshot, {
              reviewScopeSnapshotId: reviewScopeSnapshot.reviewScopeSnapshotId,
              windows,
            });
          })()
        : renderConflictAdjudicationInstruction(snapshot);
      const instruction = deps.stepExecutor.buildPhase1Instruction(
        composeFindingAdjudicationInstruction(deps.guidance, groundingInstruction),
        step,
        runtime,
      );
      const agentOptions = {
        ...deps.optionsBuilder.buildAgentOptions(step, runtime),
        sessionId: undefined,
      };
      const exactRequestBytes = requestBytes({ step, phase1Instruction: instruction, agentOptions });
      const reserved = await reserveFindingConflictAdjudication({
        ledgerStore: deps.ledgerStore,
        conflictId: conflict.id,
        expectedSnapshotId: snapshot.conflictSnapshotId,
        requestedOriginStep: lastOriginStep,
        observation,
        requestBytes: exactRequestBytes,
        scopeIdentity: deps.findingScopeIdentity,
        workflowName: deps.workflowName,
        roundMarker,
        allowGroundingRetry: grounding,
      });
      if (!reserved.result.started) {
        return noTarget(reserved.ledger, `Conflict "${conflict.id}" became ineligible.`);
      }
      lastOriginStep = reserved.result.originStep;
      await deps.ledgerStore.updateLedger((ledger) => {
        const dispatched = dispatchFindingManagerProviderCall({
          calls: ledger.findingManagerProviderCalls,
          providerCallId: reserved.result.started ? reserved.result.attempt.providerCallId : '',
          requestBytes: exactRequestBytes,
          adapterSupportsUtf8ByteUpperBound: true,
          dispatchedAt: observation,
        });
        return {
          ledger: {
            ...ledger,
            updatedAt: observation.timestamp,
            findingManagerProviderCalls: dispatched.calls,
          },
          result: undefined,
        };
      });
      deps.emitEvent('findings:ledger', structuredClone(deps.ledgerStore.loadLedger()), {
        iteration: state.iteration,
        workflowName: deps.analyticsWorkflowName,
        scopeIdentity: deps.findingScopeIdentity,
      });
      deps.refreshFindingsState();
      let agentResponse: AgentResponse;
      try {
        agentResponse = deps.stepExecutor.normalizeStructuredOutput(
          step,
          await executeAgent(step.persona, instruction, agentOptions),
          runtime,
        );
      } catch (error) {
        await completeFailedConflictAdjudication({
          ledgerStore: deps.ledgerStore,
          attemptId: reserved.result.attempt.attemptId,
          code: 'provider_failed',
          observation,
        });
        throw error;
      }
      if (agentResponse.status !== 'done') {
        await completeFailedConflictAdjudication({
          ledgerStore: deps.ledgerStore,
          attemptId: reserved.result.attempt.attemptId,
          code: 'provider_failed',
          observation,
        });
        return { response: finish(state, step, agentResponse), instruction, providerInfo };
      }
      const outputBytes = JSON.stringify(agentResponse.structuredOutput ?? {});
      if (responseUpperBound({ responseBytes: outputBytes }).tokens > reserved.result.providerCall.reservedOutputTokens) {
        await completeFailedConflictAdjudication({
          ledgerStore: deps.ledgerStore,
          attemptId: reserved.result.attempt.attemptId,
          code: 'output_oversize',
          responseBytes: outputBytes,
          observation,
        });
        return noTarget(deps.ledgerStore.loadLedger(), 'Conflict adjudication output exceeded its reservation.');
      }
      let proposal: ConflictAdjudicationProposal;
      try {
        proposal = parseConflictAdjudicationProviderOutput(agentResponse.structuredOutput);
      } catch {
        await completeFailedConflictAdjudication({
          ledgerStore: deps.ledgerStore,
          attemptId: reserved.result.attempt.attemptId,
          code: 'parse_failed',
          responseBytes: outputBytes,
          observation,
        });
        return noTarget(deps.ledgerStore.loadLedger(), 'Conflict adjudication output was invalid.');
      }
      const providerUsage = agentResponse.providerUsage?.inputTokens !== undefined
        && agentResponse.providerUsage.outputTokens !== undefined
        ? {
            inputTokens: agentResponse.providerUsage.inputTokens,
            outputTokens: agentResponse.providerUsage.outputTokens,
          }
        : undefined;
      const committed = await commitFindingConflictAdjudication({
        ledgerStore: deps.ledgerStore,
        attemptId: reserved.result.attempt.attemptId,
        proposal,
        responseBytes: outputBytes,
        ...(providerUsage === undefined ? {} : { providerUsage }),
        observation,
      });
      deps.emitEvent('findings:ledger', structuredClone(committed.ledger), {
        iteration: state.iteration,
        workflowName: deps.analyticsWorkflowName,
        scopeIdentity: deps.findingScopeIdentity,
      });
      deps.refreshFindingsState();
      if (!committed.result.applied
        && committed.result.reason === 'verification_undetermined'
        && !grounding) {
        return runAttempt(true);
      }
      const disposition = committed.result.applied ? committed.result.disposition : 'unresolved';
      const value = response({
        step,
        content: committed.result.applied
          ? `Conflict ${conflict.id} adjudication applied (${proposal.kind}).`
          : `Conflict ${conflict.id} remains unresolved (${committed.result.reason}).`,
        matchedRuleIndex: DISPOSITION_RULE_INDEX[disposition],
        structuredOutput: proposal as unknown as Record<string, unknown>,
      });
      return { response: finish(state, step, value), instruction, providerInfo };
    };
    return runAttempt(false);
  };
  return { run, getLastOriginStep: () => lastOriginStep };
}
