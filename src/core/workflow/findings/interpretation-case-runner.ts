import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import type { FindingContractConfig, WorkflowConfig } from '../../models/types.js';
import type { OptionsBuilder } from '../engine/OptionsBuilder.js';
import type { StepExecutor } from '../engine/StepExecutor.js';
import {
  beginInterpretationCases,
  completeInterpretationCases,
} from './interpretation-case-coordinator.js';
import {
  dispatchFindingManagerProviderCall,
  responseUpperBound,
} from './finding-manager-provider-call.js';
import { prepareInterpretationCaseActions } from './interpretation-case-finalizer.js';
import {
  prepareInterpretationCaseProviderRequest,
  requestInterpretationCases,
} from './manager-interpretation-agent.js';
import type { InterpretationCaseRunResult } from './manager-contracts.js';
import { MANAGER_INTERPRETATION_LIMITS } from './raw-finding-limits.js';
import type { FindingManagerStore } from './store.js';
import type { FindingObservation, InterpretationCase } from './types.js';
import type { FindingEvidenceRecord } from './types.js';
import type { CanonicalIntakeItem } from './manager-admission.js';

type ProviderCase = Extract<InterpretationCase, { kind: 'provider_case' }>;

export async function runInterpretationCases(input: {
  items: readonly CanonicalIntakeItem[];
  provisionalOnlyRawFindingIds: ReadonlySet<string>;
  ledgerStore: FindingManagerStore;
  contract: FindingContractConfig;
  workflowProvider?: WorkflowConfig['provider'];
  workflowModel?: WorkflowConfig['model'];
  optionsBuilder: OptionsBuilder;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction' | 'normalizeStructuredOutput' | 'recordSynthesizedAgentUsage'>;
  observation: FindingObservation;
  roundMarker: string;
  scopeIdentity: string;
  verifiedEvidenceRecordsByRawFindingId: ReadonlyMap<
    string,
    readonly FindingEvidenceRecord[]
  >;
}): Promise<InterpretationCaseRunResult> {
  const prepare = (ledger: Parameters<typeof prepareInterpretationCaseProviderRequest>[0]['ledger'], cases: readonly ProviderCase[]) => (
    prepareInterpretationCaseProviderRequest({
      cases,
      contract: input.contract,
      workflowProvider: input.workflowProvider,
      workflowModel: input.workflowModel,
      optionsBuilder: input.optionsBuilder,
      stepExecutor: input.stepExecutor,
      ledger,
    })
  );
  const begun = await beginInterpretationCases({
    store: input.ledgerStore,
    items: input.items,
    provisionalOnlyRawFindingIds: input.provisionalOnlyRawFindingIds,
    observation: input.observation,
    maxEpochsPerLineage: MANAGER_INTERPRETATION_LIMITS.maxInterpretationEpochsPerLineage,
    roundMarker: input.roundMarker,
    scopeIdentity: input.scopeIdentity,
    budgetLimits: {
      maxCallsPerRound: MANAGER_INTERPRETATION_LIMITS.maxManagerCallsPerStep,
      maxAdapterVisibleInputTokensPerCall: MANAGER_INTERPRETATION_LIMITS.maxInputTokensPerCall,
      maxOutputTokensPerCall: MANAGER_INTERPRETATION_LIMITS.maxOutputTokensPerCall,
      maxChargedInputTokensPerRound: MANAGER_INTERPRETATION_LIMITS.maxInputTokensPerStep,
      maxChargedOutputTokensPerRound: MANAGER_INTERPRETATION_LIMITS.maxOutputTokensPerStep,
    },
    maxCasesPerProviderCall: MANAGER_INTERPRETATION_LIMITS.maxAmbiguousCandidatesPerBatch,
    verifiedEvidenceRecordsByRawFindingId: input.verifiedEvidenceRecordsByRawFindingId,
    prepareProviderRequest: (ledger, cases) => ({
      requestBytes: prepare(ledger, cases).requestBytes,
      adapterSupportsUtf8ByteUpperBound: true,
    }),
  });

  const attemptsByCaseId = new Map(begun.attempts.map((attempt) => [attempt.caseId, attempt]));
  const casesByCallId = new Map<string, ProviderCase[]>();
  for (const plannedCase of begun.providerCases) {
    const attempt = attemptsByCaseId.get(plannedCase.caseId);
    if (attempt === undefined) {
      throw new Error(`Interpretation case "${plannedCase.caseId}" has no leased attempt`);
    }
    casesByCallId.set(attempt.providerCallId, [
      ...(casesByCallId.get(attempt.providerCallId) ?? []),
      plannedCase,
    ]);
  }

  const responses: Array<{
    caseId: string;
    decision: Parameters<typeof completeInterpretationCases>[0]['responses'][number]['decision'];
  }> = [];
  const providerFailures: Array<{ caseId: string; reason: string }> = [];
  const providerCallResults: Parameters<typeof completeInterpretationCases>[0]['providerCallResults'][number][] = [];
  for (const [providerCallId, cases] of casesByCallId) {
    const prepared = prepare(input.ledgerStore.loadLedger(), cases);
    const persistedCall = input.ledgerStore.loadLedger().findingManagerProviderCalls.find(
      (call) => call.providerCallId === providerCallId,
    );
    if (persistedCall?.state === 'dispatched') {
      providerFailures.push(...cases.map((plannedCase) => ({
        caseId: plannedCase.caseId,
        reason: 'Interpretation provider result is unknown after dispatch.',
      })));
      providerCallResults.push({
        providerCallId,
        resultKind: 'interrupted_unknown',
        failurePhase: 'provider_result_unknown',
      });
      continue;
    }
    if (persistedCall?.state !== 'reserved') {
      throw new Error(`Interpretation provider call "${providerCallId}" is not dispatchable`);
    }
    await input.ledgerStore.updateLedger((ledger) => {
      const dispatched = dispatchFindingManagerProviderCall({
        calls: ledger.findingManagerProviderCalls,
        providerCallId,
        requestBytes: prepared.requestBytes,
        adapterSupportsUtf8ByteUpperBound: true,
        dispatchedAt: input.observation,
      });
      return {
        ledger: {
          ...ledger,
          updatedAt: input.observation.timestamp,
          findingManagerProviderCalls: dispatched.calls,
        },
        result: undefined,
      };
    });
    try {
      const requested = await requestInterpretationCases({
        cases,
        contract: input.contract,
        workflowProvider: input.workflowProvider,
        workflowModel: input.workflowModel,
        optionsBuilder: input.optionsBuilder,
        stepExecutor: input.stepExecutor,
        ledger: input.ledgerStore.loadLedger(),
        prepared,
      });
      const observedOutputTokens = Math.max(
        responseUpperBound({ responseBytes: requested.responseBytes }).tokens,
        requested.providerUsage?.outputTokens ?? 0,
      );
      if (observedOutputTokens > persistedCall.reservedOutputTokens) {
        providerFailures.push(...cases.map((plannedCase) => ({
          caseId: plannedCase.caseId,
          reason: 'Interpretation provider output exceeded its reservation.',
        })));
        providerCallResults.push({
          providerCallId,
          resultKind: 'rejected',
          failurePhase: 'output_oversize',
          responseBytes: requested.responseBytes,
          ...(requested.providerUsage === undefined
            ? {}
            : { providerUsage: requested.providerUsage }),
        });
        continue;
      }
      responses.push(...requested.responses);
      providerFailures.push(...requested.omittedCaseIds.map((caseId) => ({
        caseId,
        reason: 'Interpretation provider omitted this case from its response.',
      })));
      providerCallResults.push({
        providerCallId,
        resultKind: 'accepted',
        responseBytes: requested.responseBytes,
        ...(requested.providerUsage === undefined
          ? {}
          : { providerUsage: requested.providerUsage }),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      providerFailures.push(...cases.map((plannedCase) => ({
        caseId: plannedCase.caseId,
        reason: `Interpretation provider failed: ${reason}`,
      })));
      providerCallResults.push({
        providerCallId,
        resultKind: 'rejected',
        failurePhase: 'provider_failed',
      });
    }
  }

  const completed = begun.attempts.length === 0
    ? { attempts: [] }
    : await completeInterpretationCases({
        store: input.ledgerStore,
        receipt: begun.receipt,
        responses,
        providerFailures,
        providerCallResults,
        observation: input.observation,
      });
  const completedAttemptIdsForCommit = [...new Set([
    ...begun.completedAttemptIdsForCommit,
    ...completed.attempts.map((attempt) => attempt.attemptId),
  ])].sort(compareBinaryStrings);
  const begunAttemptIds = new Set(begun.attempts.map((attempt) => attempt.attemptId));
  const settledCalls = input.ledgerStore.loadLedger().findingManagerProviderCalls.flatMap(
    (call) => call.state === 'settled'
      && call.attemptIds.some((attemptId) => begunAttemptIds.has(attemptId))
      ? [call]
      : [],
  );
  const result: InterpretationCaseRunResult = {
    items: [...input.items],
    completedAttemptIdsForCommit,
    directPlans: begun.directPlans,
    proofFastPathPlans: begun.proofFastPathPlans,
    provisionalOnlyRawFindingIds: new Set(input.provisionalOnlyRawFindingIds),
    stats: {
      ambiguousRawCount: input.items.length,
      managerCalls: settledCalls.length,
      estimatedInputTokens: settledCalls.reduce((sum, call) => sum + call.charge.inputTokens, 0),
      estimatedOutputTokens: settledCalls.reduce((sum, call) => sum + call.charge.outputTokens, 0),
      reusedCompletedDecisions: begun.completedAttemptIdsForCommit.length,
      interruptedInterpretations: begun.attempts.filter((attempt) => attempt.retryOrdinal > 0).length,
      budgetExhaustedLineages: begun.directPlans.filter((plan) => (
        plan.decision.kind === 'provisional'
        && plan.decision.reason.includes('epoch budget is exhausted')
      )).length,
    },
  };
  prepareInterpretationCaseActions({
    ledger: input.ledgerStore.loadLedger(),
    items: result.items,
    completedAttemptIds: result.completedAttemptIdsForCommit,
    directPlans: result.directPlans,
    proofFastPathPlans: result.proofFastPathPlans,
    provisionalOnlyRawFindingIds: result.provisionalOnlyRawFindingIds,
  });
  return result;
}
