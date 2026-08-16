import type { Language, WorkflowStep, WorkflowWideRule } from '../../models/types.js';
import { loadTemplate } from '../../../shared/prompts/index.js';
import { replaceTemplatePlaceholders } from './escape.js';
import type { InstructionContext } from './instruction-context.js';

export interface RenderedWorkflowWideRules {
  readonly hasAfterExecutionRules: boolean;
  readonly afterExecutionRules: string;
  readonly noticeAfterExecutionRules: string;
  readonly hasBeforeInstructionRules: boolean;
  readonly beforeInstructionRules: string;
  readonly noticeBeforeInstructionRules: string;
}

function renderRule(
  rule: WorkflowWideRule,
  language: Language,
  step: WorkflowStep,
  context: InstructionContext,
): string {
  return loadTemplate('parts/workflow_wide_rule', language, {
    ref: rule.ref,
    content: replaceTemplatePlaceholders(rule.content.trimEnd(), step, context),
  }).trimEnd();
}

function applicabilityNotice(language: Language): string {
  return loadTemplate('parts/workflow_wide_rules_notice', language).trim();
}

export function renderWorkflowWideRules(
  rules: readonly WorkflowWideRule[] | undefined,
  language: Language,
  step: WorkflowStep,
  context: InstructionContext,
): RenderedWorkflowWideRules {
  const afterExecutionRules = rules?.filter((rule) => rule.position === 'after_execution_rules') ?? [];
  const beforeInstructionRules = rules?.filter((rule) => rule.position === 'before_instruction') ?? [];
  const notice = applicabilityNotice(language);

  return {
    hasAfterExecutionRules: afterExecutionRules.length > 0,
    afterExecutionRules: afterExecutionRules.map((rule) => renderRule(rule, language, step, context)).join('\n\n'),
    noticeAfterExecutionRules: afterExecutionRules.length > 0 ? notice : '',
    hasBeforeInstructionRules: beforeInstructionRules.length > 0,
    beforeInstructionRules: beforeInstructionRules.map((rule) => renderRule(rule, language, step, context)).join('\n\n'),
    noticeBeforeInstructionRules: afterExecutionRules.length === 0 && beforeInstructionRules.length > 0
      ? notice
      : '',
  };
}
