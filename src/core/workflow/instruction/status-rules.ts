/**
 * Status rules prompt generation for workflow steps
 *
 * Generates structured status rules content that tells agents which
 * numbered tags to output based on the step's rule configuration.
 *
 * Returns individual components (criteriaTable, outputList, appendix)
 * that are passed as template variables to Phase 1/Phase 3 templates.
 */

import type { WorkflowRule, Language } from '../../models/types.js';

/** Components of the generated status rules */
export interface StatusRulesComponents {
  criteriaTable: string;
  outputList: string;
  hasAppendix: boolean;
  appendixContent: string;
}

/**
 * Generate status rules components from rules configuration.
 *
 * Loop expansion (criteria table rows, output list items, appendix blocks)
 * is done in code and returned as individual string components.
 * These are passed as template variables to the Phase 1/Phase 3 templates.
 */
export function generateStatusRulesComponents(
  stepName: string,
  rules: WorkflowRule[],
  language: Language,
  options?: { interactive?: boolean },
): StatusRulesComponents {
  const tag = stepName.toUpperCase();
  const interactiveEnabled = options?.interactive;
  const visibleRules = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => interactiveEnabled !== false || !rule.interactiveOnly);

  // Build criteria table rows
  const headerNum = '#';
  const headerCondition = language === 'ja' ? '状況' : 'Condition';
  const headerTag = language === 'ja' ? 'タグ' : 'Tag';

  const tableLines = [
    `| ${headerNum} | ${headerCondition} | ${headerTag} |`,
    '|---|------|------|',
    ...visibleRules.map(({ rule, index }) =>
      `| ${index + 1} | ${rule.condition} | \`[${tag}:${index + 1}]\` |`,
    ),
  ];
  const criteriaTable = tableLines.join('\n');

  // Build output list
  const outputInstruction = language === 'ja'
    ? '判定に対応するタグを出力してください:'
    : 'Output the tag corresponding to your decision:';

  const outputLines = [
    outputInstruction,
    '',
    ...visibleRules.map(({ rule, index }) =>
      `- \`[${tag}:${index + 1}]\` — ${rule.condition}`,
    ),
  ];
  const outputList = outputLines.join('\n');

  // Build appendix content
  const rulesWithAppendix = visibleRules.filter(({ rule }) => rule.appendix);
  const hasAppendix = rulesWithAppendix.length > 0;
  let appendixContent = '';

  if (hasAppendix) {
    const appendixInstructionTemplate = language === 'ja'
      ? '`[{tag}]` を出力する場合、以下を追記してください:'
      : 'When outputting `[{tag}]`, append the following:';

    const appendixBlocks: string[] = [];
    for (const { rule, index } of visibleRules) {
      if (!rule.appendix) continue;
      const tagStr = `[${tag}:${index + 1}]`;
      appendixBlocks.push('');
      appendixBlocks.push(appendixInstructionTemplate.replace('{tag}', tagStr));
      appendixBlocks.push('```');
      appendixBlocks.push(rule.appendix.trimEnd());
      appendixBlocks.push('```');
    }
    appendixContent = appendixBlocks.join('\n');
  }

  return { criteriaTable, outputList, hasAppendix, appendixContent };
}
