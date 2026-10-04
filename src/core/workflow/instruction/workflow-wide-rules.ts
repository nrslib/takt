import type { Language, WorkflowStep, WorkflowWideRule } from '../../models/types.js';
import { loadTemplate } from '../../../shared/prompts/index.js';
import { prepareTemplatePlaceholders } from './escape.js';
import type { InstructionContext } from './instruction-context.js';
import type { InjectedReport, PreparedInstruction } from './prepared-instruction.js';

export interface RenderedWorkflowWideRules {
  readonly injectedReports: readonly InjectedReport[];
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
): PreparedInstruction {
  const prepared = prepareTemplatePlaceholders(rule.content.trimEnd(), step, context);
  return {
    ...prepared,
    text: loadTemplate('parts/workflow_wide_rule', language, {
      ref: rule.ref,
      content: prepared.text,
    }).trimEnd(),
  };
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
  const after = afterExecutionRules.map((rule) => renderRule(rule, language, step, context));
  const before = beforeInstructionRules.map((rule) => renderRule(rule, language, step, context));

  return {
    injectedReports: [...after, ...before].flatMap((rule) => rule.injectedReports),
    hasAfterExecutionRules: afterExecutionRules.length > 0,
    afterExecutionRules: after.map((rule) => rule.text).join('\n\n'),
    noticeAfterExecutionRules: afterExecutionRules.length > 0 ? notice : '',
    hasBeforeInstructionRules: beforeInstructionRules.length > 0,
    beforeInstructionRules: before.map((rule) => rule.text).join('\n\n'),
    noticeBeforeInstructionRules: afterExecutionRules.length === 0 && beforeInstructionRules.length > 0
      ? notice
      : '',
  };
}
