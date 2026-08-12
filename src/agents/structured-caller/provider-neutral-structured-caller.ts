import type { SemanticRuleCandidate } from '../../core/models/workflow-rule-condition.js';
import type { AgentResponse } from '../../core/models/types.js';
import {
  judgeStatus,
  evaluateCondition,
  type JudgeStatusOptions,
  type JudgeStatusResult,
  type EvaluateConditionOptions,
} from '../judge-status-usecase.js';
import {
  decomposeTask,
  requestDecompositionRawResponse,
  requestMoreParts,
  requestMorePartsRawResponse,
  type DecomposeTaskOptions,
  type DecomposeTaskResponse,
  type MorePartsOptions,
  type MorePartsResponse,
  type TeamLeaderPartFeedbackResult,
} from '../decompose-task-usecase.js';
import type { StructuredCaller } from './contracts.js';

/** The single provider-neutral StructuredCaller implementation. */
export class ProviderNeutralStructuredCaller implements StructuredCaller {
  judgeStatus(
    structuredInstruction: string,
    tagInstruction: string,
    candidates: SemanticRuleCandidate[],
    options: JudgeStatusOptions,
  ): Promise<JudgeStatusResult> {
    return judgeStatus(structuredInstruction, tagInstruction, candidates, options);
  }

  async evaluateCondition(
    agentOutput: string,
    conditions: Array<{ index: number; text: string }>,
    options: EvaluateConditionOptions,
  ): Promise<number> {
    const normalized = conditions.map((condition, index) => ({ index, text: condition.text }));
    const match = await evaluateCondition(agentOutput, normalized, options);
    return match < 0 ? -1 : conditions[match]?.index ?? -1;
  }

  decomposeTask(
    instruction: string,
    maxInitialParts: number | undefined,
    options: DecomposeTaskOptions,
  ): Promise<DecomposeTaskResponse> {
    return decomposeTask(instruction, maxInitialParts, options);
  }

  requestDecompositionRawResponse(
    instruction: string,
    maxInitialParts: number | undefined,
    options: DecomposeTaskOptions,
  ): Promise<AgentResponse> {
    return requestDecompositionRawResponse(instruction, maxInitialParts, options);
  }

  requestMoreParts(
    originalInstruction: string,
    allResults: TeamLeaderPartFeedbackResult[],
    existingIds: string[],
    options: MorePartsOptions,
  ): Promise<MorePartsResponse> {
    return requestMoreParts(originalInstruction, allResults, existingIds, options);
  }

  requestMorePartsRawResponse(
    originalInstruction: string,
    allResults: TeamLeaderPartFeedbackResult[],
    existingIds: string[],
    options: MorePartsOptions,
  ): Promise<AgentResponse> {
    return requestMorePartsRawResponse(originalInstruction, allResults, existingIds, options);
  }
}
