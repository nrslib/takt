import type { AgentWorkflowStep, FindingContractConfig } from '../../models/types.js';
import type { OptionsBuilder } from '../engine/OptionsBuilder.js';
import type { StepExecutor } from '../engine/StepExecutor.js';
import { buildManagerInstruction, parseManagerDecisions, runPreparedManagerAttempt } from './manager-agent.js';
import type { FindingLedger, FindingManagerDecisions, RawFinding } from './types.js';
import { estimateTokens, RAW_ADJUDICATION_RECOVERY_LIMITS } from './raw-finding-limits.js';

interface PreparedRawAdjudicationBatch {
  batch: RawFinding[];
  phase1Instruction: string;
  inputTokens: number;
}

export function prepareRawAdjudicationBatch(input: {
  queue: RawFinding[];
  contract: FindingContractConfig;
  previousLedger: FindingLedger;
  mechanicallyClassifiedCount: number;
  managerStep: AgentWorkflowStep;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction'>;
}): PreparedRawAdjudicationBatch {
  const prepare = (batch: RawFinding[]): PreparedRawAdjudicationBatch => {
    const batchRawFindingIds = new Set(batch.map((rawFinding) => rawFinding.rawFindingId));
    const contextFindings = input.previousLedger.findings.filter((finding) => (
      finding.provisional === undefined
      || finding.rawFindingIds.some((rawFindingId) => batchRawFindingIds.has(rawFindingId))
    ));
    const contextFindingIds = new Set(contextFindings.map((finding) => finding.id));
    const fullDetailFindingIds = new Set(
      contextFindings
        .filter((finding) => finding.rawFindingIds.some((rawFindingId) => (
          batchRawFindingIds.has(rawFindingId)
        )))
        .map((finding) => finding.id),
    );
    const contextLedger: FindingLedger = {
      ...input.previousLedger,
      findings: contextFindings,
      conflicts: input.previousLedger.conflicts.filter((conflict) => (
        conflict.findingIds.every((findingId) => contextFindingIds.has(findingId))
      )),
    };
    const instruction = buildManagerInstruction({
      contract: input.contract,
      previousLedger: contextLedger,
      residualRawFindings: batch,
      mechanicallyClassifiedCount: input.mechanicallyClassifiedCount,
      priorStepResponseText: undefined,
      invalidLocationCandidates: new Map(),
      dismissCandidates: new Map(),
      verifiedEvidenceRecordsByRawFindingId: new Map(
        batch.map((rawFinding) => [
          rawFinding.rawFindingId,
          input.previousLedger.evidenceRecords,
        ]),
      ),
      fullDetailFindingIds,
    });
    const phase1Instruction = input.stepExecutor.buildPhase1Instruction(instruction, input.managerStep);
    const inputTokens = estimateTokens(phase1Instruction);
    if (batch.length > 1 && inputTokens > RAW_ADJUDICATION_RECOVERY_LIMITS.maxInputTokensPerCall) {
      return prepare(batch.slice(0, Math.max(1, Math.floor(batch.length / 2))));
    }
    return { batch, phase1Instruction, inputTokens };
  };
  return prepare(input.queue.slice(0, RAW_ADJUDICATION_RECOVERY_LIMITS.maxReplayCandidatesPerBatch));
}

export function rawDecisionsOnly(
  rawDecisions: FindingManagerDecisions['rawDecisions'],
): FindingManagerDecisions {
  return {
    rawDecisions,
    disputeDecisions: [],
    conflictDecisions: [],
    invalidateDecisions: [],
    duplicateDecisions: [],
    dismissDecisions: [],
  };
}

export async function requestRawAdjudicationBatch(input: {
  managerStep: AgentWorkflowStep;
  phase1Instruction: string;
  optionsBuilder: OptionsBuilder;
  stepExecutor: Pick<StepExecutor, 'normalizeStructuredOutput' | 'recordSynthesizedAgentUsage'>;
  consumedOutputTokens: number;
  rawFindings: readonly RawFinding[];
}): Promise<{ decisions: FindingManagerDecisions; outputTokens: number }> {
  const response = await runPreparedManagerAttempt(input);
  const outputTokens = estimateTokens(JSON.stringify(response.structuredOutput ?? {}));
  if (outputTokens > RAW_ADJUDICATION_RECOVERY_LIMITS.maxOutputTokensPerCall) {
    throw new Error(`Raw adjudication output exceeded the per-call budget (${outputTokens} estimated tokens)`);
  }
  if (input.consumedOutputTokens + outputTokens
    > RAW_ADJUDICATION_RECOVERY_LIMITS.maxOutputTokensPerStep) {
    throw new Error(`Raw adjudication output exceeded the per-step budget (${input.consumedOutputTokens + outputTokens} estimated tokens)`);
  }
  return {
    decisions: rawDecisionsOnly(
      parseManagerDecisions(response, input.rawFindings).rawDecisions,
    ),
    outputTokens,
  };
}
