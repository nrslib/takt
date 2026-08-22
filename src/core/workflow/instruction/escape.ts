/**
 * Template escaping and placeholder replacement utilities
 *
 * Used by instruction builders to process resolved instruction content.
 *
 * escapeTemplateChars is re-exported from faceted-prompting.
 * replaceTemplatePlaceholders is TAKT-specific and stays here.
 */

import type { WorkflowStep } from '../../models/types.js';
import { isReviewMode } from '../../models/review-mode.js';
import type { InstructionContext } from './instruction-context.js';
import { resolveWorkflowStateReference } from '../state/workflow-state-access.js';
import { REPORT_REFERENCE_PATTERN, resolveReportReference } from './report-reference.js';
import { renderTaskReviewScope } from '../review-scope.js';
import { escapeTemplateChars } from 'faceted-prompting';

export { escapeTemplateChars } from 'faceted-prompting';

/**
 * Replace supported placeholders in the resolved instruction body.
 */
export function replaceTemplatePlaceholders(
  template: string,
  step: WorkflowStep,
  context: InstructionContext,
): string {
  let result = template;

  result = result.replace(/\{var:([^}]+)\}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    const variables = context.workflowCallVars;
    if (variables === undefined || !Object.hasOwn(variables, name)) {
      return 'unspecified';
    }
    if (name === 'review_mode' && !isReviewMode(variables[name])) {
      return 'mode_unknown';
    }
    return escapeTemplateChars(String(variables[name]));
  });

  result = result.replace(/\{(context|structured|effect):([^}]+)\}/g, (_match, root: string, ref: string) => {
    if (!context.workflowState) {
      throw new Error(`Workflow state is required for "{${root}:${ref}}" interpolation`);
    }
    const value = resolveWorkflowStateReference(`${root}.${ref.replace(/:/g, '.')}`, context.workflowState);
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return escapeTemplateChars(String(value));
    }
    if (root !== 'context') {
      throw new Error(`Instruction interpolation requires scalar value for "${root}:${ref}"`);
    }
    return escapeTemplateChars(JSON.stringify(value, null, 2));
  });

  // Replace {task}
  result = result.replace(/\{task\}/g, escapeTemplateChars(context.task));

  // Replace {iteration}, {max_steps}, and {step_iteration}
  result = result.replace(/\{iteration\}/g, String(context.iteration));
  result = result.replace(/\{max_steps\}/g, String(context.maxSteps));
  result = result.replace(/\{step_iteration\}/g, String(context.stepIteration));

  // Replace {previous_response}
  if (step.passPreviousResponse) {
    if (context.previousResponseText !== undefined) {
      result = result.replace(
        /\{previous_response\}/g,
        escapeTemplateChars(context.previousResponseText),
      );
    } else if (context.previousOutput) {
      result = result.replace(
        /\{previous_response\}/g,
        escapeTemplateChars(context.previousOutput.content),
      );
    } else {
      result = result.replace(/\{previous_response\}/g, '');
    }
  }

  // Replace {user_inputs}
  const userInputsStr = context.userInputs.join('\n');
  result = result.replace(
    /\{user_inputs\}/g,
    escapeTemplateChars(userInputsStr),
  );

  // Replace {review_scope}. 本文は renderTaskReviewScope 側でエスケープ済みなので
  // ここでは再エスケープしない。
  result = result.replace(
    /\{review_scope\}/g,
    () => renderTaskReviewScope(context.reviewScope, context.language ?? 'en'),
  );

  // Replace {report_dir}
  if (context.reportDir) {
    result = result.replace(/\{report_dir\}/g, context.reportDir);
  }

  // Replace {report:filename} with the verified report content.
  // 単純な文字列連結ではなく専用リゾルバを通す: containment / 存在 /
  // 通常ファイルを検証する。現 run で見つからない場合は resume snapshot の
  // 元 run 座標を引き、それでも無ければ平易な欠落文へ置換して実行を続ける。
  if (context.reportDir) {
    const reportDir = context.reportDir;
    result = result.replace(REPORT_REFERENCE_PATTERN, (_match, filename: string) => {
      return resolveReportReference(reportDir, filename.trim(), {
        stepName: step.name,
        reportsRootDir: context.reportsRootDir,
        resumeReportConsumerKey: context.resumeReportConsumerKey,
        validateExistence: context.validateReportReferences !== false,
      });
    });
  }

  return result;
}
