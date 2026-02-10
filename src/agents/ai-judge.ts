/**
 * AI judge - provider-aware rule condition evaluator
 *
 * Evaluates agent output against ai() conditions using the configured provider.
 * Uses runAgent (which resolves provider from config) instead of hardcoded Claude.
 */

import type { AiJudgeCaller, AiJudgeCondition } from '../core/piece/types.js';
import { loadTemplate } from '../shared/prompts/index.js';
import { createLogger } from '../shared/utils/index.js';
import { runAgent } from './runner.js';

const log = createLogger('ai-judge');

/**
 * Detect judge rule index from [JUDGE:N] tag pattern.
 * Returns 0-based rule index, or -1 if no match.
 */
export function detectJudgeIndex(content: string): number {
  const regex = /\[JUDGE:(\d+)\]/i;
  const match = content.match(regex);
  if (match?.[1]) {
    const index = Number.parseInt(match[1], 10) - 1;
    return index >= 0 ? index : -1;
  }
  return -1;
}

/**
 * Build the prompt for the AI judge that evaluates agent output against ai() conditions.
 */
export function buildJudgePrompt(
  agentOutput: string,
  aiConditions: AiJudgeCondition[],
): string {
  const conditionList = aiConditions
    .map((c) => `| ${c.index + 1} | ${c.text} |`)
    .join('\n');

  return loadTemplate('perform_judge_message', 'en', { agentOutput, conditionList });
}

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
  const prompt = buildJudgePrompt(agentOutput, conditions);

  const response = await runAgent(undefined, prompt, {
    cwd: options.cwd,
    maxTurns: 1,
    allowedTools: [],
  });

  if (response.status !== 'done') {
    log.error('AI judge call failed', { error: response.error });
    return -1;
  }

  return detectJudgeIndex(response.content);
};
