import { loadTemplate } from '../shared/prompts/index.js';

export function detectJudgeIndex(content: string): number {
  const regex = /\[JUDGE:(\d+)\]/i;
  const match = content.match(regex);
  if (match?.[1]) {
    const index = Number.parseInt(match[1], 10) - 1;
    return index >= 0 ? index : -1;
  }
  return -1;
}

export function buildJudgePrompt(
  agentOutput: string,
  aiConditions: Array<{ index: number; text: string }>,
): string {
  const conditionList = aiConditions
    .map((c) => `| ${c.index + 1} | ${c.text} |`)
    .join('\n');

  return loadTemplate('perform_judge_message', 'en', { agentOutput, conditionList });
}
