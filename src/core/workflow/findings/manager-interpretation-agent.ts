import type { FindingContractConfig, WorkflowConfig } from '../../models/types.js';
import type { OptionsBuilder } from '../engine/OptionsBuilder.js';
import type { StepExecutor } from '../engine/StepExecutor.js';
import { renderFencedJsonBlock } from '../instruction/fenced-block.js';
import { createLogger } from '../../../shared/utils/index.js';
import { parseAmbiguousInterpretations } from './schemas.js';
import { buildFindingInterpretationStep } from './manager-step.js';
import { MANAGER_INTERPRETATION_LIMITS, estimateTokens } from './raw-finding-limits.js';
import { validateAmbiguousInterpretations } from './raw-capabilities.js';
import { buildManagerInputLedger, runManagerAttempt } from './manager-agent.js';
import type { AmbiguousInterpretation, DeterministicSameProof, FindingLedger } from './types.js';
import type { CanonicalIntakeItem } from './manager-admission.js';
import type { LadderTarget } from './manager-contracts.js';

const log = createLogger('finding-manager-interpretation');

function buildInterpretationInstruction(input: {
  contract: FindingContractConfig;
  previousLedger: FindingLedger;
  batch: readonly LadderTarget[];
  proofsByRawId: ReadonlyMap<string, DeterministicSameProof>;
}): string {
  const detailIds = new Set<string>();
  for (const target of input.batch) {
    if (target.canonical.targetFindingId !== undefined) {
      detailIds.add(target.canonical.targetFindingId);
    }
  }
  const ledgerView = buildManagerInputLedger(input.previousLedger, detailIds);
  const batchView = input.batch.map((target) => ({
    rawFindingId: target.canonical.rawFindingId,
    reviewer: target.canonical.reviewer,
    claimedRelation: target.canonical.relation,
    targetFindingId: target.canonical.targetFindingId ?? null,
    ambiguityCodes: target.canonical.provenance.ambiguityCodes,
    title: target.wire.title,
    location: target.wire.location ?? null,
    severity: target.wire.severity,
    description: target.wire.description,
    availableSameProofId: input.proofsByRawId.get(target.canonical.rawFindingId)?.proofId ?? null,
    availableSameProofTarget: input.proofsByRawId.get(target.canonical.rawFindingId)?.targetFindingId ?? null,
  }));
  return [
    input.contract.manager.instruction,
    '',
    '## Ambiguous raw finding interpretation',
    'The raw findings below arrived with contradictory or incomplete labeling against the finding ledger, and one reviewer clarification round did not settle them. For EACH raw finding, return exactly one interpretation PROPOSAL. You have no authority over the ledger: the engine validates every proposal against the capabilities it granted, and anything outside them becomes a gate-blocking provisional finding.',
    '',
    'Allowed decisions:',
    '- create_independent: the observation is a real, independent problem. A NEW open finding is created. Existing findings are never touched.',
    '- same_with_proof: ONLY if availableSameProofId is non-null for that raw finding — echo that proofId. You cannot mint proof ids, and textual similarity is never proof.',
    '- open_conflict: the observation relates to an existing OPEN finding but you cannot determine identity. An active conflict is recorded; the finding is not closed.',
    '- provisional: you cannot determine the meaning. The observation is kept as a gate-blocking provisional finding (state the reason).',
    '',
    'You can NEVER resolve, waive, invalidate, supersede, or reopen a finding from here, and a raw finding whose claimed relation is resolution_confirmation can only land as open_conflict or provisional.',
    '',
    '## Current ledger',
    renderFencedJsonBlock(ledgerView),
    '',
    '## Ambiguous raw findings',
    renderFencedJsonBlock(batchView),
  ].join('\n');
}

export interface PreparedInterpretationBatch {
  batch: LadderTarget[];
  instruction: string;
  inputTokens: number;
}

export function prepareInterpretationBatch(input: {
  queue: LadderTarget[];
  contract: FindingContractConfig;
  previousLedger: FindingLedger;
  proofsByRawId: ReadonlyMap<string, DeterministicSameProof>;
}): PreparedInterpretationBatch {
  const prepare = (batch: LadderTarget[]): PreparedInterpretationBatch => {
    const instruction = buildInterpretationInstruction({
      contract: input.contract,
      previousLedger: input.previousLedger,
      batch,
      proofsByRawId: input.proofsByRawId,
    });
    const inputTokens = estimateTokens(instruction);
    if (batch.length > 1 && inputTokens > MANAGER_INTERPRETATION_LIMITS.maxInputTokensPerCall) {
      return prepare(batch.slice(0, Math.max(1, Math.floor(batch.length / 2))));
    }
    return { batch, instruction, inputTokens };
  };
  return prepare(input.queue.slice(0, MANAGER_INTERPRETATION_LIMITS.maxAmbiguousCandidatesPerBatch));
}

export async function requestInterpretationBatch(input: {
  batch: LadderTarget[];
  instruction: string;
  contract: FindingContractConfig;
  workflowProvider?: WorkflowConfig['provider'];
  workflowModel?: WorkflowConfig['model'];
  optionsBuilder: OptionsBuilder;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction' | 'normalizeStructuredOutput' | 'recordSynthesizedAgentUsage'>;
  previousLedger: FindingLedger;
  ambiguousByRawId: ReadonlyMap<string, CanonicalIntakeItem['canonical']>;
  targetsByRawId: ReadonlyMap<string, LadderTarget>;
  proofsByRawId: ReadonlyMap<string, DeterministicSameProof>;
}): Promise<{ decisions: Map<string, AmbiguousInterpretation>; outputTokens: number }> {
  let outputTokens = 0;
  try {
    const response = await runManagerAttempt({
      managerStep: buildFindingInterpretationStep({
        contract: input.contract,
        workflowProvider: input.workflowProvider,
        workflowModel: input.workflowModel,
      }),
      instruction: input.instruction,
      optionsBuilder: input.optionsBuilder,
      stepExecutor: input.stepExecutor,
    });
    if (response.status !== 'done') {
      throw new Error(`Finding interpreter failed with status "${response.status}": ${response.error ?? response.content}`);
    }
    outputTokens = estimateTokens(JSON.stringify(response.structuredOutput ?? {}));
    if (outputTokens > MANAGER_INTERPRETATION_LIMITS.maxOutputTokensPerCall) {
      throw new Error(`Finding interpreter output exceeded the per-call budget (${outputTokens} estimated tokens)`);
    }
    const batchRawIds = new Set(input.batch.map((target) => target.canonical.rawFindingId));
    const validation = validateAmbiguousInterpretations({
      parsed: parseAmbiguousInterpretations(response.structuredOutput ?? {})
        .filter((proposal) => batchRawIds.has(proposal.rawFindingId)),
      ambiguousByRawId: input.ambiguousByRawId,
      issuedProofsByRawId: input.proofsByRawId,
      ledger: input.previousLedger,
    });
    const validatedDecisions = validation.validated.reduce<Map<string, AmbiguousInterpretation>>((decisions, item) => {
      const rawFindingId = item.outcome === 'accepted'
        ? item.interpretation.rawFindingId
        : item.rawFindingId;
      const target = input.targetsByRawId.get(rawFindingId)!;
      if (item.outcome !== 'accepted') {
        return new Map([...decisions, [target.interpretationKey, {
          decision: 'provisional' as const,
          rawFindingId,
          reason: item.reason,
        }]]);
      }
      const raw = input.ambiguousByRawId.get(rawFindingId)!;
      const decision = raw.relation === 'resolution_confirmation'
        && (item.interpretation.decision === 'create_independent'
          || item.interpretation.decision === 'same_with_proof')
        ? {
          decision: 'provisional' as const,
          rawFindingId,
          reason: `Interpretation "${item.interpretation.decision}" is not allowed for a resolution_confirmation claim; kept provisional`,
        }
        : item.interpretation;
      return new Map([...decisions, [target.interpretationKey, decision]]);
    }, new Map());
    const decisions = input.batch.reduce<Map<string, AmbiguousInterpretation>>((current, target) => (
      current.has(target.interpretationKey)
        ? current
        : new Map([...current, [target.interpretationKey, {
          decision: 'provisional' as const,
          rawFindingId: target.canonical.rawFindingId,
          reason: 'Manager returned no interpretation for this raw finding',
        }]])
    ), validatedDecisions);
    return { decisions, outputTokens };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('Finding interpretation call failed; landing the batch as provisional', { error: message });
    return {
      decisions: new Map(input.batch.map((target) => [
        target.interpretationKey,
        {
          decision: 'provisional' as const,
          rawFindingId: target.canonical.rawFindingId,
          reason: `Manager interpretation failed: ${message}`,
        },
      ])),
      outputTokens,
    };
  }
}
