import type { Language, WorkflowWideRule } from '../../models/types.js';
import { loadTemplate } from '../../../shared/prompts/index.js';

export interface RenderedWorkflowWideRules {
  readonly hasAfterExecutionRules: boolean;
  readonly afterExecutionRules: string;
  readonly noticeAfterExecutionRules: string;
  readonly hasBeforeInstructionRules: boolean;
  readonly beforeInstructionRules: string;
  readonly noticeBeforeInstructionRules: string;
}

function renderRule(rule: WorkflowWideRule, language: Language): string {
  return loadTemplate('parts/workflow_wide_rule', language, {
    ref: rule.ref,
    content: rule.content.trimEnd(),
  }).trimEnd();
}

function applicabilityNotice(language: Language): string {
  return loadTemplate('parts/workflow_wide_rules_notice', language).trim();
}

export function renderWorkflowWideRules(
  rules: readonly WorkflowWideRule[] | undefined,
  language: Language,
): RenderedWorkflowWideRules {
  const afterExecutionRules = rules?.filter((rule) => rule.position === 'after_execution_rules') ?? [];
  const beforeInstructionRules = rules?.filter((rule) => rule.position === 'before_instruction') ?? [];
  const notice = applicabilityNotice(language);

  return {
    hasAfterExecutionRules: afterExecutionRules.length > 0,
    afterExecutionRules: afterExecutionRules.map((rule) => renderRule(rule, language)).join('\n\n'),
    noticeAfterExecutionRules: afterExecutionRules.length > 0 ? notice : '',
    hasBeforeInstructionRules: beforeInstructionRules.length > 0,
    beforeInstructionRules: beforeInstructionRules.map((rule) => renderRule(rule, language)).join('\n\n'),
    noticeBeforeInstructionRules: afterExecutionRules.length === 0 && beforeInstructionRules.length > 0
      ? notice
      : '',
  };
}
