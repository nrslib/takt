import type { SemanticRuleCandidate } from '../../core/models/workflow-rule-condition.js';
import type { JudgeStatusOptions, JudgeStatusResult, EvaluateConditionOptions } from '../judge-status-usecase.js';
import type {
  DecomposeTaskOptions,
  DecomposeTaskResponse,
  MorePartsOptions,
  MorePartsResponse,
  TeamLeaderPartFeedbackResult,
} from '../decompose-task-usecase.js';

export interface StructuredCaller {
  judgeStatus(
    structuredInstruction: string,
    tagInstruction: string,
    candidates: SemanticRuleCandidate[],
    options: JudgeStatusOptions,
  ): Promise<JudgeStatusResult>;

  evaluateCondition(
    agentOutput: string,
    conditions: Array<{ index: number; text: string }>,
    options: EvaluateConditionOptions,
  ): Promise<number>;

  decomposeTask(
    instruction: string,
    maxInitialParts: number | undefined,
    options: DecomposeTaskOptions,
  ): Promise<DecomposeTaskResponse>;

  requestMoreParts(
    originalInstruction: string,
    allResults: TeamLeaderPartFeedbackResult[],
    existingIds: string[],
    options: MorePartsOptions,
  ): Promise<MorePartsResponse>;
}
