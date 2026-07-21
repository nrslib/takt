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
  ledgerCopyPath: string;
  rawFindingsPath: string;
  mechanicallyClassifiedCount: number;
  managerStep: AgentWorkflowStep;
  stepExecutor: Pick<StepExecutor, 'buildPhase1Instruction'>;
}): PreparedRawAdjudicationBatch {
  const prepare = (batch: RawFinding[]): PreparedRawAdjudicationBatch => {
    const instruction = buildManagerInstruction({
      contract: input.contract,
      previousLedger: input.previousLedger,
      ledgerCopyPath: input.ledgerCopyPath,
      rawFindingsPath: input.rawFindingsPath,
      residualRawFindings: batch,
      mechanicallyClassifiedCount: input.mechanicallyClassifiedCount,
      priorStepResponseText: undefined,
      invalidLocationCandidates: new Map(),
      dismissCandidates: new Map(),
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
    decisions: rawDecisionsOnly(parseManagerDecisions(response).rawDecisions),
    outputTokens,
  };
}
