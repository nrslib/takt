import type { FindingContractConfig, WorkflowConfig } from '../../models/types.js';
import type { OptionsBuilder } from '../engine/OptionsBuilder.js';
import type { StepExecutor } from '../engine/StepExecutor.js';
import {
  computeProvisionalStableKey,
} from './raw-canonicalization.js';
import { MANAGER_INTERPRETATION_LIMITS } from './raw-finding-limits.js';
import {
  beginInterpretations,
  completeInterpretations,
  releaseInterpretationReservations,
  type NewInterpretationInput,
} from './interpretation-wal.js';
import type { FindingManagerStore } from './store.js';
import type { FindingLedger, FindingObservation } from './types.js';
import type { CanonicalIntakeItem } from './manager-admission.js';
import type { LadderResult, LadderTarget } from './manager-contracts.js';
import {
  prepareInterpretationBatch,
  requestInterpretationBatch,
} from './manager-interpretation-agent.js';
import {
  applyInterpretationDecisions,
  classifyInitialLadderTargets,
  classifyInterpretationWal,
  emptyLadderResult,
} from './manager-interpretation-plan.js';

export async function runAmbiguousLadder(input: {
  tainted: readonly CanonicalIntakeItem[];
  /** 検証不能な継続指摘に台帳の確定的な変異を許さないための rawFindingId 集合。 */
  provisionalOnlyRawFindingIds: ReadonlySet<string>;
  previousLedger: FindingLedger;
  ledgerStore: FindingManagerStore;
  contract: FindingContractConfig;
  workflowProvider?: WorkflowConfig['provider'];
  workflowModel?: WorkflowConfig['model'];
  optionsBuilder: OptionsBuilder;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction' | 'normalizeStructuredOutput' | 'recordSynthesizedAgentUsage'>;
  observation: FindingObservation;
  workflowName: string;
  callNamespace: string;
  parentStepName: string;
}): Promise<LadderResult> {
  if (input.tainted.length === 0) {
    return emptyLadderResult(0);
  }
  const initial = classifyInitialLadderTargets(input);
  let result = initial.result;
  const proofsByRawId = initial.proofsByRawId;
  const needsInterpretation = initial.needsInterpretation;
  const plannedTargets = needsInterpretation.slice(0, MANAGER_INTERPRETATION_LIMITS.maxInterpretationTargetsPerStep);
  let leftover = needsInterpretation.slice(MANAGER_INTERPRETATION_LIMITS.maxInterpretationTargetsPerStep);

  const begin = await beginInterpretations(
    input.ledgerStore,
    plannedTargets.map((target): NewInterpretationInput => ({
      baseInterpretationKey: target.baseInterpretationKey,
      reviewerStableKey: target.canonical.reviewerStableKey,
      lineageKey: target.canonical.lineageKey,
      candidateEvidenceHash: target.canonical.evidenceHash,
      promptPreconditions: [],
    })),
    input.observation,
  );
  let retainReservationsForCommit = false;
  try {
    const interpretationTargets = plannedTargets.map((target): LadderTarget => {
      const attempt = begin.attemptByBaseKey.get(target.baseInterpretationKey);
      if (attempt === undefined) {
        throw new Error(`Interpretation attempt was not reserved for base key "${target.baseInterpretationKey}"`);
      }
      return { ...target, ...attempt };
    });
    const wal = classifyInterpretationWal({
      targets: interpretationTargets,
      begin,
      result,
      provisionalOnlyRawFindingIds: input.provisionalOnlyRawFindingIds,
    });
    result = wal.result;
    let decidedByKey = wal.decidedByKey;

    const ambiguousByRawId = new Map(input.tainted.map((item) => [item.canonical.rawFindingId, item.canonical]));
    const targetsByRawId = new Map(interpretationTargets.map((target) => [target.canonical.rawFindingId, target]));
    let callCount = 0;
    let queue = [...wal.toCall];
    while (queue.length > 0) {
      if (callCount >= MANAGER_INTERPRETATION_LIMITS.maxManagerCallsPerStep
        || result.stats.estimatedInputTokens >= MANAGER_INTERPRETATION_LIMITS.maxInputTokensPerStep
        || result.stats.estimatedOutputTokens >= MANAGER_INTERPRETATION_LIMITS.maxOutputTokensPerStep) {
        leftover = [...leftover, ...queue];
        queue = [];
        break;
      }
      const prepared = prepareInterpretationBatch({
        queue,
        contract: input.contract,
        previousLedger: input.previousLedger,
        proofsByRawId,
      });
      if (prepared.inputTokens > MANAGER_INTERPRETATION_LIMITS.maxInputTokensPerCall
        || result.stats.estimatedInputTokens + prepared.inputTokens > MANAGER_INTERPRETATION_LIMITS.maxInputTokensPerStep) {
        leftover = [...leftover, ...queue];
        queue = [];
        break;
      }
      const batchResult = await requestInterpretationBatch({
        batch: prepared.batch,
        instruction: prepared.instruction,
        contract: input.contract,
        workflowProvider: input.workflowProvider,
        workflowModel: input.workflowModel,
        optionsBuilder: input.optionsBuilder,
        stepExecutor: input.stepExecutor,
        previousLedger: input.previousLedger,
        ambiguousByRawId,
        targetsByRawId,
        proofsByRawId,
      });
      const completed = await completeInterpretations(
        input.ledgerStore,
        batchResult.decisions,
        begin.ownedByKey,
        input.observation,
      );
      queue = queue.slice(prepared.batch.length);
      callCount += 1;
      result = {
        ...result,
        stats: {
          ...result.stats,
          managerCalls: callCount,
          estimatedInputTokens: result.stats.estimatedInputTokens + prepared.inputTokens,
          estimatedOutputTokens: result.stats.estimatedOutputTokens + batchResult.outputTokens,
        },
      };
      decidedByKey = new Map([...decidedByKey, ...completed]);
    }

    if (leftover.length > 0) {
      const leftoverByLineage = new Map(
        leftover.map((target) => [target.canonical.lineageKey, target]),
      );
      result = {
        ...result,
        provisionalSpecs: [
          ...result.provisionalSpecs,
          ...[...leftoverByLineage.values()].map((target) => ({
            kind: 'manager-budget-exhausted' as const,
            stableKey: computeProvisionalStableKey({
              reviewerStableKey: target.canonical.reviewerStableKey,
              lineageKey: target.canonical.lineageKey,
              provisionalKind: 'manager-budget-exhausted',
            }),
            lineageKey: target.canonical.lineageKey,
            sourceRawFindingIds: [target.wire.rawFindingId],
            reason: 'Manager interpretation budget was exhausted before this lineage could be interpreted',
            title: `Pending interpretation: ${target.wire.title}`,
            severity: 'high' as const,
            description: target.wire.description,
            reviewers: [target.wire.reviewer],
            recoveryReviewerStableKey: target.canonical.reviewerStableKey,
          })),
        ],
        stats: { ...result.stats, budgetExhaustedLineages: leftoverByLineage.size },
      };
    }
    const applied = applyInterpretationDecisions({
      result,
      decisions: decidedByKey,
      interpretationTargets,
      provisionalOnlyRawFindingIds: input.provisionalOnlyRawFindingIds,
      proofsByRawId,
    });
    retainReservationsForCommit = true;
    return { ...applied, interpretationReservations: begin.ownedByKey };
  } finally {
    if (!retainReservationsForCommit) {
      releaseInterpretationReservations(input.ledgerStore, begin.ownedByKey);
    }
  }
}
