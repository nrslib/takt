/**
 * AI judge - provider-aware rule condition evaluator
 *
 * Evaluates agent output against ai() conditions using the configured provider.
 * Uses runAgent (which resolves provider from config) instead of hardcoded Claude.
 */

import type { AiJudgeCaller, AiJudgeCondition } from '../core/piece/types.js';
import { createLogger } from '../shared/utils/index.js';
import { evaluateCondition } from './agent-usecases.js';

const log = createLogger('ai-judge');

export { detectJudgeIndex, buildJudgePrompt } from './judge-utils.js';

/**
 * Call AI judge to evaluate agent output against ai() conditions.
 * Uses the provider system (via runAgent) for correct provider resolution.
 * Returns 0-based index of the matched ai() condition, or -1 if no match.
 */
export const callAiJudge: AiJudgeCaller = async (
  agentOutput: string,
  conditions: AiJudgeCondition[],
  options: { cwd: string },
): Promise<number> => {
  const result = await evaluateCondition(agentOutput, conditions, options);
  if (result < 0) {
    log.error('AI judge call failed to match a condition');
  }
  return result;
};
