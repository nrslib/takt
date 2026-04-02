import type { PieceRule, PartDefinition } from '../../core/models/types.js';
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
  type MorePartsResponse,
} from '../decompose-task-usecase.js';
import type { StructuredCaller } from './contracts.js';

export class DefaultStructuredCaller implements StructuredCaller {
  async judgeStatus(
    structuredInstruction: string,
    tagInstruction: string,
    rules: PieceRule[],
    options: JudgeStatusOptions,
  ): Promise<JudgeStatusResult> {
    return judgeStatus(structuredInstruction, tagInstruction, rules, options);
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
    maxParts: number,
    options: DecomposeTaskOptions,
  ): Promise<PartDefinition[]> {
    return decomposeTask(instruction, maxParts, options);
  }

  async requestMoreParts(
    originalInstruction: string,
    allResults: Array<{ id: string; title: string; status: string; content: string }>,
    existingIds: string[],
    maxAdditionalParts: number,
    options: DecomposeTaskOptions,
  ): Promise<MorePartsResponse> {
    return requestMoreParts(
      originalInstruction,
      allResults,
      existingIds,
      maxAdditionalParts,
      options,
    );
  }
}
