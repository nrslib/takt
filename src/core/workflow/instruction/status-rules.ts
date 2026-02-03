/**
 * Status rules prompt generation for workflow steps
 *
 * Generates structured prompts that tell agents which numbered tags to output
 * based on the step's rule configuration.
 */

import type { WorkflowRule, Language } from '../../models/types.js';
import { getPromptObject } from '../../../shared/prompts/index.js';

/** Shape of localized status rules strings */
interface StatusRulesStrings {
  criteriaHeading: string;
  headerNum: string;
  headerCondition: string;
  headerTag: string;
  outputHeading: string;
  outputInstruction: string;
  appendixHeading: string;
  appendixInstruction: string;
}

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
  options?: { interactive?: boolean },
): string {
  const tag = stepName.toUpperCase();
  const strings = getPromptObject<StatusRulesStrings>('instruction.statusRules', language);
  const interactiveEnabled = options?.interactive;
  const visibleRules = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => interactiveEnabled !== false || !rule.interactiveOnly);

  const lines: string[] = [];

  // Criteria table
  lines.push(strings.criteriaHeading);
  lines.push('');
  lines.push(`| ${strings.headerNum} | ${strings.headerCondition} | ${strings.headerTag} |`);
  lines.push('|---|------|------|');
  for (const { rule, index } of visibleRules) {
    lines.push(`| ${index + 1} | ${rule.condition} | \`[${tag}:${index + 1}]\` |`);
  }
  lines.push('');

  // Output format
  lines.push(strings.outputHeading);
  lines.push('');
  lines.push(strings.outputInstruction);
  lines.push('');
  for (const { rule, index } of visibleRules) {
    lines.push(`- \`[${tag}:${index + 1}]\` — ${rule.condition}`);
  }

  // Appendix templates (if any rules have appendix)
  const rulesWithAppendix = visibleRules.filter(({ rule }) => rule.appendix);
  if (rulesWithAppendix.length > 0) {
    lines.push('');
    lines.push(strings.appendixHeading);
    for (const { rule, index } of visibleRules) {
      if (!rule.appendix) continue;
      const tagStr = `[${tag}:${index + 1}]`;
      lines.push('');
      // appendixInstruction contains {tag} as a domain-specific placeholder, not a YAML template variable
      lines.push(strings.appendixInstruction.replace('{tag}', tagStr));
      lines.push('```');
      lines.push(rule.appendix.trimEnd());
      lines.push('```');
    }
  }

  return lines.join('\n');
}
