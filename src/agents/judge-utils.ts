import type { WorkflowRule } from '../core/models/types.js';
import { isDeterministicCondition } from '../core/workflow/evaluation/rule-utils.js';
import { loadTemplate } from '../shared/prompts/index.js';

export function isValidRuleIndex(index: number, rules: WorkflowRule[], interactive: boolean): boolean {
  if (index < 0 || index >= rules.length) return false;
  const rule = rules[index];
  if (rule === undefined) return false;
  if (rule.interactiveOnly && !interactive) return false;
  // 決定的条件（findings.* 等）はエンジンが実状態から評価するもので、
  // モデルの申告で成立させてはならない（偽の conflict 宣言でゲートを
  // 落とせてしまう）。判定の選択対象から機械的に除外する。
  return !isDeterministicCondition(rule.condition);
}

export function buildJudgeConditions(
  rules: WorkflowRule[],
  interactive: boolean,
  indexes?: number[],
): Array<{ index: number; text: string }> {
  return rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => interactive || !rule.interactiveOnly)
    .filter(({ rule }) => !isDeterministicCondition(rule.condition))
    .map(({ index, rule }) => ({ index: indexes?.[index] ?? index, text: rule.condition }));
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
