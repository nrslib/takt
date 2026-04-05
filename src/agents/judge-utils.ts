import type { PieceRule } from '../core/models/types.js';
import { loadTemplate } from '../shared/prompts/index.js';

export function isValidRuleIndex(index: number, rules: PieceRule[], interactive: boolean): boolean {
  if (index < 0 || index >= rules.length) return false;
  const rule = rules[index];
  return !(rule?.interactiveOnly && !interactive);
}

export function buildJudgeConditions(
  rules: PieceRule[],
  interactive: boolean,
): Array<{ index: number; text: string }> {
  return rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => interactive || !rule.interactiveOnly)
    .map(({ index, rule }) => ({ index, text: rule.condition }));
}

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
