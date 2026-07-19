import type { FindingContractConfig, WorkflowConfig } from '../../models/types.js';
import type { OptionsBuilder } from '../engine/OptionsBuilder.js';
import type { StepExecutor } from '../engine/StepExecutor.js';
import {
  computeLineageKey,
  computeProvisionalStableKey,
  computeReviewerStableKey,
} from './raw-canonicalization.js';
import { MANAGER_INTERPRETATION_LIMITS } from './raw-finding-limits.js';
import {
  beginInterpretations,
  completeInterpretations,
  type NewInterpretationInput,
} from './interpretation-wal.js';
import type { FindingManagerStore } from './store.js';
import type { FindingLedger, FindingObservation } from './types.js';
import type { CanonicalIntakeItem } from './manager-admission.js';
import type { LadderResult } from './manager-contracts.js';
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
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction' | 'normalizeStructuredOutput'>;
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
  const interpretationTargets = needsInterpretation.slice(0, MANAGER_INTERPRETATION_LIMITS.maxInterpretationTargetsPerStep);
  let leftover = needsInterpretation.slice(MANAGER_INTERPRETATION_LIMITS.maxInterpretationTargetsPerStep);

  const begin = await beginInterpretations(
    input.ledgerStore,
    interpretationTargets.map((target): NewInterpretationInput => ({
      interpretationKey: target.interpretationKey,
      reviewerStableKey: target.canonical.reviewerStableKey,
      lineageKey: target.canonical.lineageKey,
      candidateEvidenceHash: target.canonical.evidenceHash,
      promptPreconditions: [],
    })),
    input.observation,
  );

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
    await completeInterpretations(input.ledgerStore, batchResult.decisions, input.observation);
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
    decidedByKey = new Map([...decidedByKey, ...batchResult.decisions]);
  }

  if (leftover.length > 0) {
    const reviewerStableKey = computeReviewerStableKey({
      workflowName: input.workflowName,
      callNamespace: input.callNamespace,
      parentStepName: input.parentStepName,
      reviewerPersonaKey: 'findings-manager',
    });
    const lineageKey = computeLineageKey({ title: 'Finding manager interpretation budget exhausted' });
    result = {
      ...result,
      provisionalSpecs: [...result.provisionalSpecs, {
        kind: 'manager-budget-exhausted',
        stableKey: computeProvisionalStableKey({ reviewerStableKey, lineageKey, provisionalKind: 'manager-budget-exhausted' }),
        lineageKey,
        sourceRawFindingIds: leftover.map((target) => target.wire.rawFindingId),
        reason: `Manager interpretation budget was exhausted before ${leftover.length} ambiguous raw finding(s) could be interpreted. Affected lineages: ${leftover.map((target) => target.canonical.lineageKey.slice(0, 12)).join(', ')}`,
        title: 'Finding manager interpretation budget exhausted',
        severity: 'high',
        description: `Uninterpreted ambiguous observations remain (${leftover.length}); they block the final gate until a later round interprets or settles them.`,
        reviewers: ['findings-manager'],
        addInterpretationEpochs: 0,
      }],
      stats: { ...result.stats, budgetExhaustedLineages: leftover.length },
    };
  }
  return applyInterpretationDecisions({
    result,
    decisions: decidedByKey,
    interpretationTargets,
    provisionalOnlyRawFindingIds: input.provisionalOnlyRawFindingIds,
    proofsByRawId,
  });
}
