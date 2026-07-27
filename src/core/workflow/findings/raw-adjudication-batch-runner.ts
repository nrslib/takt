import { createLogger } from '../../../shared/utils/index.js';
import type { AgentWorkflowStep } from '../../models/types.js';
import { assembleCleanManagerDecision } from './manager-clean-decision.js';
import type { RawAdmissionEvaluation } from './manager-admission.js';
import type {
  RawAdjudicationFailure,
  RunFindingManagerForStepInput,
} from './manager-contracts.js';
import type { MechanicalClassificationResult } from './mechanical-classification.js';
import { createEmptyManagerOutput } from './manager-output.js';
import { collectLandedRawIds } from './manager-utils.js';
import type { FindingManagerValidationAttemptReport, UnsupportedRawFindingReport } from './store.js';
import type { FindingLedger, FindingManagerDecisions, FindingManagerOutput, RawFinding } from './types.js';
import {
  prepareRawAdjudicationBatch,
  rawDecisionsOnly,
  requestRawAdjudicationBatch,
} from './raw-adjudication-agent.js';
import { RAW_ADJUDICATION_RECOVERY_LIMITS } from './raw-finding-limits.js';
import { buildRawAdjudicationManagerStep } from './raw-adjudication-step.js';

const log = createLogger('raw-adjudication-recovery');

function admissionForBatch(
  admission: RawAdmissionEvaluation,
  batchRawIds: ReadonlySet<string>,
): RawAdmissionEvaluation {
  return {
    ...admission,
    cleanWire: admission.cleanWire.filter((wire) => batchRawIds.has(wire.rawFindingId)),
    cleanAdmitted: admission.cleanAdmitted.filter((item) => batchRawIds.has(item.wire.rawFindingId)),
  };
}

function recordBatchSpecs(
  specs: ReturnType<typeof assembleCleanManagerDecision>['cleanProvisionalSpecs'],
): Map<string, RawAdjudicationFailure> {
  const failures = new Map<string, RawAdjudicationFailure>();
  for (const spec of specs) {
    for (const rawFindingId of spec.sourceRawFindingIds) {
      failures.set(rawFindingId, {
        kind: 'provisional_landing',
        outcome: 'audit_only',
        reason: spec.reason,
      });
    }
  }
  return failures;
}

function appendInvalidAttempts(
  current: FindingManagerValidationAttemptReport[],
  extra: FindingManagerValidationAttemptReport[],
): FindingManagerValidationAttemptReport[] {
  return [
    ...current,
    ...extra.map((attempt) => ({
      ...attempt,
      attempt: current.length + attempt.attempt,
    })),
  ];
}

function recordWholeOutputDiscard(input: {
  failures: Map<string, RawAdjudicationFailure>;
  rawFindingIds: ReadonlySet<string>;
}): void {
  for (const rawFindingId of input.rawFindingIds) {
    if (!input.failures.has(rawFindingId)) {
      input.failures.set(rawFindingId, {
        kind: 'manager_output_rejected',
        outcome: 'audit_only',
        reason: 'Manager output violated ledger invariants and was discarded',
      });
    }
  }
}

interface RawAdjudicationBatchExecution {
  output: FindingManagerOutput;
  failures: Map<string, RawAdjudicationFailure>;
  invalidAttempts: FindingManagerValidationAttemptReport[];
  unsupportedRawFindingReports: UnsupportedRawFindingReport[];
  sentRawIds: Set<string>;
}

export async function runRawAdjudicationBatches(input: {
  runInput: Pick<RunFindingManagerForStepInput, 'contract' | 'optionsBuilder' | 'stepExecutor'>;
  previousLedger: FindingLedger;
  managerStep: AgentWorkflowStep;
  admission: RawAdmissionEvaluation;
  mechanical: MechanicalClassificationResult;
  mechanicallyClassifiedCount: number;
}): Promise<RawAdjudicationBatchExecution> {
  let invalidAttempts: FindingManagerValidationAttemptReport[] = [];
  const failures = new Map<string, RawAdjudicationFailure>();
  const sentRawIds = new Set<string>();
  const successfulRawFindings: RawFinding[] = [];
  const successfulRawDecisions: FindingManagerDecisions['rawDecisions'] = [];
  const rawManagerStep = buildRawAdjudicationManagerStep(input.managerStep);
  let queue = [...input.mechanical.residualRawFindings];
  let callCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  while (queue.length > 0
    && callCount < RAW_ADJUDICATION_RECOVERY_LIMITS.maxManagerCallsPerStep
    && outputTokens < RAW_ADJUDICATION_RECOVERY_LIMITS.maxOutputTokensPerStep) {
    const batch = prepareRawAdjudicationBatch({
      queue,
      contract: input.runInput.contract,
      previousLedger: input.previousLedger,
      mechanicallyClassifiedCount: input.mechanicallyClassifiedCount,
      managerStep: rawManagerStep,
      stepExecutor: input.runInput.stepExecutor,
    });
    if (batch.inputTokens > RAW_ADJUDICATION_RECOVERY_LIMITS.maxInputTokensPerCall) {
      const rawFindingId = batch.batch[0]?.rawFindingId;
      if (rawFindingId !== undefined) {
        sentRawIds.add(rawFindingId);
        failures.set(rawFindingId, {
          kind: 'input_budget_exceeded',
          outcome: 'audit_only',
          reason: `Raw adjudication input exceeded the per-call budget (${batch.inputTokens} estimated tokens)`,
        });
      }
      break;
    }
    if (inputTokens + batch.inputTokens > RAW_ADJUDICATION_RECOVERY_LIMITS.maxInputTokensPerStep) {
      break;
    }
    const batchRawIds = new Set(batch.batch.map((wire) => wire.rawFindingId));
    for (const rawFindingId of batchRawIds) {
      sentRawIds.add(rawFindingId);
    }
    queue = queue.slice(batch.batch.length);
    callCount += 1;
    inputTokens += batch.inputTokens;
    try {
      const response = await requestRawAdjudicationBatch({
        managerStep: rawManagerStep,
        phase1Instruction: batch.phase1Instruction,
        optionsBuilder: input.runInput.optionsBuilder,
        stepExecutor: input.runInput.stepExecutor,
        consumedOutputTokens: outputTokens,
      });
      outputTokens += response.outputTokens;
      const clean = assembleCleanManagerDecision({
        previousLedger: input.previousLedger,
        admission: admissionForBatch(input.admission, batchRawIds),
        mechanical: { output: createEmptyManagerOutput(), residualRawFindings: batch.batch },
        decisions: response.decisions,
        initialInvalidAttempts: [],
        invalidLocationCandidateFindingIds: new Set(),
        dismissCandidateFindingIds: new Set(),
        priorStepResponseText: undefined,
      });
      const recorded = recordBatchSpecs(clean.cleanProvisionalSpecs);
      if (clean.wholeOutputDiscarded) {
        invalidAttempts = appendInvalidAttempts(invalidAttempts, clean.invalidAttempts);
        for (const [rawFindingId, failure] of recorded) {
          failures.set(rawFindingId, failure);
        }
        recordWholeOutputDiscard({ failures, rawFindingIds: batchRawIds });
        break;
      }
      successfulRawFindings.push(...batch.batch);
      successfulRawDecisions.push(...response.decisions.rawDecisions);
      for (const [rawFindingId, failure] of recorded) {
        failures.set(rawFindingId, failure);
      }
      for (const unsupported of clean.unsupportedRawFindingReports) {
        failures.set(unsupported.rawFindingId, {
          kind: 'manager_unsupported',
          outcome: 'unsupported',
          reason: unsupported.evidence,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('Raw adjudication replay call failed', { error: message });
      for (const rawFindingId of batchRawIds) {
        failures.set(rawFindingId, {
          kind: 'agent_failed',
          outcome: 'audit_only',
          reason: message,
        });
      }
      invalidAttempts = [...invalidAttempts, {
        attempt: invalidAttempts.length + 1,
        managerOutput: { error: message },
        validationErrors: [message],
      }];
      break;
    }
  }
  const successfulRawIds = new Set(successfulRawFindings.map((raw) => raw.rawFindingId));
  const includedRawIds = new Set([
    ...collectLandedRawIds(input.mechanical.output),
    ...successfulRawIds,
  ]);
  const clean = assembleCleanManagerDecision({
    previousLedger: input.previousLedger,
    admission: admissionForBatch(input.admission, includedRawIds),
    mechanical: {
      output: input.mechanical.output,
      residualRawFindings: successfulRawFindings,
    },
    decisions: successfulRawFindings.length === 0
      ? undefined
      : rawDecisionsOnly(successfulRawDecisions),
    initialInvalidAttempts: invalidAttempts,
    invalidLocationCandidateFindingIds: new Set(),
    dismissCandidateFindingIds: new Set(),
    priorStepResponseText: undefined,
  });
  for (const [rawFindingId, failure] of recordBatchSpecs(clean.cleanProvisionalSpecs)) {
    failures.set(rawFindingId, failure);
  }
  for (const unsupported of clean.unsupportedRawFindingReports) {
    failures.set(unsupported.rawFindingId, {
      kind: 'manager_unsupported',
      outcome: 'unsupported',
      reason: unsupported.evidence,
    });
  }
  if (clean.wholeOutputDiscarded) {
    recordWholeOutputDiscard({ failures, rawFindingIds: successfulRawIds });
  }
  return {
    output: clean.managerOutput,
    failures,
    invalidAttempts: clean.invalidAttempts,
    unsupportedRawFindingReports: clean.unsupportedRawFindingReports,
    sentRawIds,
  };
}
