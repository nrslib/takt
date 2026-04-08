import type { WorkflowRule, PartDefinition } from '../../core/models/types.js';
import type { JudgeStatusOptions, JudgeStatusResult, EvaluateConditionOptions } from '../judge-status-usecase.js';
import type { DecomposeTaskOptions, MorePartsResponse } from '../decompose-task-usecase.js';

export interface StructuredCaller {
  judgeStatus(
    structuredInstruction: string,
    tagInstruction: string,
    rules: WorkflowRule[],
    options: JudgeStatusOptions,
  ): Promise<JudgeStatusResult>;

  evaluateCondition(
    agentOutput: string,
    conditions: Array<{ index: number; text: string }>,
    options: EvaluateConditionOptions,
  ): Promise<number>;

  decomposeTask(
    instruction: string,
    maxParts: number,
    options: DecomposeTaskOptions,
  ): Promise<PartDefinition[]>;

  requestMoreParts(
    originalInstruction: string,
    allResults: Array<{ id: string; title: string; status: string; content: string }>,
    existingIds: string[],
    maxAdditionalParts: number,
    options: DecomposeTaskOptions,
  ): Promise<MorePartsResponse>;
}
