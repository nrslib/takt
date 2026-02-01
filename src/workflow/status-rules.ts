/**
 * Status rules prompt generation for workflow steps
 *
 * Generates structured prompts that tell agents which numbered tags to output
 * based on the step's rule configuration.
 */

import type { WorkflowRule, Language } from '../models/types.js';

/** Localized strings for rules-based status prompt */
const RULES_PROMPT_STRINGS = {
  en: {
    criteriaHeading: '## Decision Criteria',
    headerNum: '#',
    headerCondition: 'Condition',
    headerTag: 'Tag',
    outputHeading: '## Output Format',
    outputInstruction: 'Output the tag corresponding to your decision:',
    appendixHeading: '### Appendix Template',
    appendixInstruction: 'When outputting `[{tag}]`, append the following:',
  },
  ja: {
    criteriaHeading: '## 判定基準',
    headerNum: '#',
    headerCondition: '状況',
    headerTag: 'タグ',
    outputHeading: '## 出力フォーマット',
    outputInstruction: '判定に対応するタグを出力してください:',
    appendixHeading: '### 追加出力テンプレート',
    appendixInstruction: '`[{tag}]` を出力する場合、以下を追記してください:',
  },
} as const;

/**
 * Generate status rules prompt from rules configuration.
 * Creates a structured prompt that tells the agent which numbered tags to output.
 *
 * Example output for step "plan" with 3 rules:
 *   ## 判定基準
 *   | # | 状況 | タグ |
 *   |---|------|------|
 *   | 1 | 要件が明確で実装可能 | `[PLAN:1]` |
 *   | 2 | ユーザーが質問をしている | `[PLAN:2]` |
 *   | 3 | 要件が不明確、情報不足 | `[PLAN:3]` |
 */
export function generateStatusRulesFromRules(
  stepName: string,
  rules: WorkflowRule[],
  language: Language,
): string {
  const tag = stepName.toUpperCase();
  const strings = RULES_PROMPT_STRINGS[language];

  const lines: string[] = [];

  // Criteria table
  lines.push(strings.criteriaHeading);
  lines.push('');
  lines.push(`| ${strings.headerNum} | ${strings.headerCondition} | ${strings.headerTag} |`);
  lines.push('|---|------|------|');
  for (const [i, rule] of rules.entries()) {
    lines.push(`| ${i + 1} | ${rule.condition} | \`[${tag}:${i + 1}]\` |`);
  }
  lines.push('');

  // Output format
  lines.push(strings.outputHeading);
  lines.push('');
  lines.push(strings.outputInstruction);
  lines.push('');
  for (const [i, rule] of rules.entries()) {
    lines.push(`- \`[${tag}:${i + 1}]\` — ${rule.condition}`);
  }

  // Appendix templates (if any rules have appendix)
  const rulesWithAppendix = rules.filter((r) => r.appendix);
  if (rulesWithAppendix.length > 0) {
    lines.push('');
    lines.push(strings.appendixHeading);
    for (const [i, rule] of rules.entries()) {
      if (!rule.appendix) continue;
      const tagStr = `[${tag}:${i + 1}]`;
      lines.push('');
      lines.push(strings.appendixInstruction.replace('{tag}', tagStr));
      lines.push('```');
      lines.push(rule.appendix.trimEnd());
      lines.push('```');
    }
  }

  return lines.join('\n');
}
