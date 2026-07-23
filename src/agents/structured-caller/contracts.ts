import type { SemanticRuleCandidate } from '../../core/models/workflow-rule-condition.js';
import type { AgentResponse } from '../../core/models/types.js';
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

  requestDecompositionRawResponse(
    instruction: string,
    maxInitialParts: number | undefined,
    options: DecomposeTaskOptions,
  ): Promise<AgentResponse>;

  requestMoreParts(
    originalInstruction: string,
    allResults: TeamLeaderPartFeedbackResult[],
    existingIds: string[],
    options: MorePartsOptions,
  ): Promise<MorePartsResponse>;

  requestMorePartsRawResponse(
    originalInstruction: string,
    allResults: TeamLeaderPartFeedbackResult[],
    existingIds: string[],
    options: MorePartsOptions,
  ): Promise<AgentResponse>;
}
