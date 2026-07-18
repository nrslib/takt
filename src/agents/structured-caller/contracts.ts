import type { WorkflowRule } from '../../core/models/types.js';
import type { JudgeStatusOptions, JudgeStatusResult, EvaluateConditionOptions } from '../judge-status-usecase.js';
import type { DecomposeTaskOptions, DecomposeTaskResponse, MorePartsOptions, MorePartsResponse } from '../decompose-task-usecase.js';

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
    maxTotalParts: number,
    options: DecomposeTaskOptions,
  ): Promise<DecomposeTaskResponse>;

  requestMoreParts(
    originalInstruction: string,
    allResults: Array<{ id: string; title: string; status: string; content: string }>,
    existingIds: string[],
    maxAdditionalParts: number,
    options: MorePartsOptions,
  ): Promise<MorePartsResponse>;
}
