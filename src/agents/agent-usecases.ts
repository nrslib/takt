import type { AgentResponse } from '../core/models/types.js';
import { runAgent, type RunAgentOptions } from './runner.js';

export {
  evaluateCondition,
  judgeStatus,
  type EvaluateConditionOptions,
  type JudgeStatusOptions,
  type JudgeStatusResult,
} from './judge-status-usecase.js';
export {
  decomposeTask,
  requestMoreParts,
  type DecomposeTaskOptions,
  type MorePartsResponse,
} from './decompose-task-usecase.js';

export async function executeAgent(
  persona: string | undefined,
  instruction: string,
  options: RunAgentOptions,
): Promise<AgentResponse> {
  return runAgent(persona, instruction, options);
}

export const generateReport = executeAgent;
export const executePart = executeAgent;
