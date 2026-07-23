import type { SemanticRuleCandidate } from '../../core/models/workflow-rule-condition.js';
import {
  judgeStatus,
  evaluateCondition,
  type JudgeStatusOptions,
  type JudgeStatusResult,
  type EvaluateConditionOptions,
} from '../judge-status-usecase.js';
import {
  decomposeTask,
  requestMoreParts,
  type DecomposeTaskOptions,
  type DecomposeTaskResponse,
  type MorePartsOptions,
  type MorePartsResponse,
  type TeamLeaderPartFeedbackResult,
} from '../decompose-task-usecase.js';
import type { StructuredCaller } from './contracts.js';

export class DefaultStructuredCaller implements StructuredCaller {
  async judgeStatus(
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
    const normalizedConditions = conditions.map((condition, position) => ({
      index: position,
      text: condition.text,
    }));
    const matchedPosition = await evaluateCondition(agentOutput, normalizedConditions, options);
    if (matchedPosition < 0) {
      return -1;
    }

    return conditions[matchedPosition]?.index ?? -1;
  }

  async decomposeTask(
    instruction: string,
    maxInitialParts: number | undefined,
    options: DecomposeTaskOptions,
  ): Promise<DecomposeTaskResponse> {
    return decomposeTask(instruction, maxInitialParts, options);
  }

  async requestMoreParts(
    originalInstruction: string,
    allResults: TeamLeaderPartFeedbackResult[],
    existingIds: string[],
    options: MorePartsOptions,
  ): Promise<MorePartsResponse> {
    return requestMoreParts(
      originalInstruction,
      allResults,
      existingIds,
      options,
    );
  }
}
