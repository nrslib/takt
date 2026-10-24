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
import { formatMissingReportReference, resolveReportReferenceDetailed } from './report-reference.js';
import { classifyReportRelativePath } from '../../models/reserved-report-names.js';
import type { InjectedReport, PreparedInstruction } from './prepared-instruction.js';
import { CURRENT_REPORT_BODY_LIMIT, renderCurrentReport } from './prepared-instruction.js';
import { pinReportContent } from '../report-writer.js';
import { renderTaskReviewScope } from '../review-scope.js';
import { escapeTemplateChars } from '#faceted-prompting';

export { escapeTemplateChars } from '#faceted-prompting';

/**
 * Replace supported placeholders in the resolved instruction body.
 */
export function replaceTemplatePlaceholders(
  template: string,
  step: WorkflowStep,
  context: InstructionContext,
): string {
  return prepareTemplatePlaceholders(template, step, context).text;
}

export function prepareTemplatePlaceholders(
  template: string,
  step: WorkflowStep,
  context: InstructionContext,
): PreparedInstruction {
  let result = template;
  const injectedReports = new Map<string, InjectedReport>();

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
    result = result.replace(/\{(report|report_history):([^}]+)\}/g, (_match, kind: string, filename: string) => {
      const reference = filename.trim();
      const classification = classifyReportRelativePath(reference);
      const normalizedReference = classification.kind === 'public'
        ? classification.normalizedPath
        : reference;
      const declarations = context.declaredReportInputs ?? [];
      const declaredMatches = declarations.flatMap(({ reports }) =>
        reports.filter((report) => report.reference === normalizedReference));
      const reservedBy = declarations.filter(({ declaredNames }) => declaredNames.includes(normalizedReference));
      if (declaredMatches.length > 1 || reservedBy.length > 1) {
        throw new Error(`Report reference "${normalizedReference}" has ambiguous declared inputs`);
      }
      const key = `${kind}:${normalizedReference}`;
      const existing = injectedReports.get(key);
      if (existing !== undefined) return existing.content;
      const declared = declaredMatches[0];
      if (kind === 'report_history') {
        if (context.validateReportReferences === false) return _match;
        if (declared?.history === undefined) {
          if (reservedBy.length === 1 && declared === undefined) return `History unavailable: producer for "${normalizedReference}" has not run`;
          throw new Error(`Report history "${normalizedReference}" requires a declared history input`);
        }
        injectedReports.set(key, { reference: declared.reference, scope: declared.scope, producer: declared.producer,
          kind: 'history', content: declared.history });
        return declared.history;
      }
      if (declared !== undefined) {
        const content = renderCurrentReport(declared);
        injectedReports.set(key, { ...declared, content });
        return content;
      }
      if (reservedBy.length === 1) {
        const missing = formatMissingReportReference(normalizedReference);
        injectedReports.set(key, { reference: normalizedReference, scope: 'missing', content: missing });
        return missing;
      }
      if (context.unavailableLocalReports?.includes(normalizedReference)) {
        const missing = formatMissingReportReference(normalizedReference);
        injectedReports.set(key, { reference: normalizedReference, scope: 'missing', content: missing });
        return missing;
      }
      let resolvedPath: string | undefined;
      const resolved = resolveReportReferenceDetailed(reportDir, reference, {
        stepName: step.name,
        reportsRootDir: context.reportsRootDir,
        resumeReportConsumerKey: context.resumeReportConsumerKey,
        validateExistence: context.validateReportReferences !== false,
        onResolvedPath: (path) => { resolvedPath = path; },
      });
      if (resolvedPath !== undefined && context.isUnavailableReportPath?.(resolvedPath)) {
        const missing = formatMissingReportReference(normalizedReference);
        injectedReports.set(key, { reference: normalizedReference, scope: 'missing', content: missing });
        return missing;
      }
      if (context.validateReportReferences === false) return resolved.content;
      const path = resolved.content.length > CURRENT_REPORT_BODY_LIMIT
        ? pinReportContent(reportDir, normalizedReference, resolved.content) : undefined;
      const content = renderCurrentReport({ reference: normalizedReference, ...resolved, path });
      injectedReports.set(key, { reference: normalizedReference, ...resolved, content, path });
      return content;
    });
  }

  return { text: result, injectedReports: [...injectedReports.values()] };
}
