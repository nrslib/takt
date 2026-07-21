import { createLogger } from '../../../shared/utils/index.js';
import type { AgentWorkflowStep } from '../../models/types.js';
import { assembleCleanManagerDecision } from './manager-clean-decision.js';
import type { RawAdmissionEvaluation } from './manager-admission.js';
import type { RunFindingManagerForStepInput } from './manager-contracts.js';
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
): Map<string, string> {
  const failureReasons = new Map<string, string>();
  for (const spec of specs) {
    for (const rawFindingId of spec.sourceRawFindingIds) {
      failureReasons.set(rawFindingId, spec.reason);
    }
  }
  return failureReasons;
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
  failureReasons: Map<string, string>;
  rawFindingIds: ReadonlySet<string>;
}): void {
  for (const rawFindingId of input.rawFindingIds) {
    if (!input.failureReasons.has(rawFindingId)) {
      input.failureReasons.set(
        rawFindingId,
        'Manager output violated ledger invariants and was discarded',
      );
    }
  }
}

interface RawAdjudicationBatchExecution {
  output: FindingManagerOutput;
  failureReasons: Map<string, string>;
  invalidAttempts: FindingManagerValidationAttemptReport[];
  unsupportedRawFindingReports: UnsupportedRawFindingReport[];
  sentRawIds: Set<string>;
}

export async function runRawAdjudicationBatches(input: {
  runInput: Pick<RunFindingManagerForStepInput, 'contract' | 'optionsBuilder' | 'stepExecutor'>;
  previousLedger: FindingLedger;
  managerStep: AgentWorkflowStep;
  ledgerCopyPath: string;
  rawFindingsPath: string;
  admission: RawAdmissionEvaluation;
  mechanical: MechanicalClassificationResult;
  mechanicallyClassifiedCount: number;
}): Promise<RawAdjudicationBatchExecution> {
  let invalidAttempts: FindingManagerValidationAttemptReport[] = [];
  const failureReasons = new Map<string, string>();
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
      ledgerCopyPath: input.ledgerCopyPath,
      rawFindingsPath: input.rawFindingsPath,
      mechanicallyClassifiedCount: input.mechanicallyClassifiedCount,
      managerStep: rawManagerStep,
      stepExecutor: input.runInput.stepExecutor,
    });
    if (batch.inputTokens > RAW_ADJUDICATION_RECOVERY_LIMITS.maxInputTokensPerCall) {
      const rawFindingId = batch.batch[0]?.rawFindingId;
      if (rawFindingId !== undefined) {
        sentRawIds.add(rawFindingId);
        failureReasons.set(
          rawFindingId,
          `Raw adjudication input exceeded the per-call budget (${batch.inputTokens} estimated tokens)`,
        );
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
        for (const [rawFindingId, reason] of recorded) {
          failureReasons.set(rawFindingId, reason);
        }
        recordWholeOutputDiscard({ failureReasons, rawFindingIds: batchRawIds });
        break;
      }
      successfulRawFindings.push(...batch.batch);
      successfulRawDecisions.push(...response.decisions.rawDecisions);
      for (const [rawFindingId, reason] of recorded) {
        failureReasons.set(rawFindingId, reason);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('Raw adjudication replay call failed', { error: message });
      for (const rawFindingId of batchRawIds) {
        failureReasons.set(rawFindingId, message);
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
  for (const [rawFindingId, reason] of recordBatchSpecs(clean.cleanProvisionalSpecs)) {
    failureReasons.set(rawFindingId, reason);
  }
  if (clean.wholeOutputDiscarded) {
    recordWholeOutputDiscard({ failureReasons, rawFindingIds: successfulRawIds });
  }
  return {
    output: clean.managerOutput,
    failureReasons,
    invalidAttempts: clean.invalidAttempts,
    unsupportedRawFindingReports: clean.unsupportedRawFindingReports,
    sentRawIds,
  };
}
