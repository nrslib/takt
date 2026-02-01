/**
 * Instruction template builder for workflow steps
 *
 * Builds the instruction string for agent execution by:
 * 1. Auto-injecting standard sections (Execution Context, Workflow Context,
 *    User Request, Previous Response, Additional User Inputs, Instructions header,
 *    Status Output Rules)
 * 2. Replacing template placeholders with actual values
 *
 * Status rules are injected into Phase 1 for tag-based detection,
 * and also used in Phase 3 (buildStatusJudgmentInstruction) as a dedicated follow-up.
 */

import type { WorkflowStep, Language, ReportConfig, ReportObjectConfig } from '../models/types.js';
import { hasTagBasedRules } from './rule-utils.js';
import type { InstructionContext } from './instruction-context.js';
import { buildExecutionMetadata, renderExecutionMetadata, METADATA_STRINGS } from './instruction-context.js';
import { generateStatusRulesFromRules } from './status-rules.js';

// Re-export from sub-modules for backward compatibility
export type { InstructionContext, ExecutionMetadata } from './instruction-context.js';
export { buildExecutionMetadata, renderExecutionMetadata } from './instruction-context.js';
export { generateStatusRulesFromRules } from './status-rules.js';

/**
 * Escape special characters in dynamic content to prevent template injection.
 */
function escapeTemplateChars(str: string): string {
  return str.replace(/\{/g, '｛').replace(/\}/g, '｝');
}

/**
 * Check if a report config is the object form (ReportObjectConfig).
 */
export function isReportObjectConfig(report: string | ReportConfig[] | ReportObjectConfig): report is ReportObjectConfig {
  return typeof report === 'object' && !Array.isArray(report) && 'name' in report;
}

/** Localized strings for auto-injected sections */
const SECTION_STRINGS = {
  en: {
    workflowContext: '## Workflow Context',
    iteration: 'Iteration',
    iterationWorkflowWide: '(workflow-wide)',
    stepIteration: 'Step Iteration',
    stepIterationTimes: '(times this step has run)',
    step: 'Step',
    reportDirectory: 'Report Directory',
    reportFile: 'Report File',
    reportFiles: 'Report Files',
    userRequest: '## User Request',
    previousResponse: '## Previous Response',
    additionalUserInputs: '## Additional User Inputs',
    instructions: '## Instructions',
  },
  ja: {
    workflowContext: '## Workflow Context',
    iteration: 'Iteration',
    iterationWorkflowWide: '（ワークフロー全体）',
    stepIteration: 'Step Iteration',
    stepIterationTimes: '（このステップの実行回数）',
    step: 'Step',
    reportDirectory: 'Report Directory',
    reportFile: 'Report File',
    reportFiles: 'Report Files',
    userRequest: '## User Request',
    previousResponse: '## Previous Response',
    additionalUserInputs: '## Additional User Inputs',
    instructions: '## Instructions',
  },
} as const;

/** Localized strings for auto-generated report output instructions */
const REPORT_OUTPUT_STRINGS = {
  en: {
    singleHeading: '**Report output:** Output to the `Report File` specified above.',
    multiHeading: '**Report output:** Output to the `Report Files` specified above.',
    createRule: '- If file does not exist: Create new file',
    appendRule: '- If file exists: Append with `## Iteration {step_iteration}` section',
  },
  ja: {
    singleHeading: '**レポート出力:** `Report File` に出力してください。',
    multiHeading: '**レポート出力:** Report Files に出力してください。',
    createRule: '- ファイルが存在しない場合: 新規作成',
    appendRule: '- ファイルが存在する場合: `## Iteration {step_iteration}` セクションを追記',
  },
} as const;

/**
 * Generate report output instructions from step.report config.
 * Returns undefined if step has no report or no reportDir.
 *
 * This replaces the manual `order:` fields and instruction_template
 * report output blocks that were previously hand-written in each YAML.
 */
function renderReportOutputInstruction(
  step: WorkflowStep,
  context: InstructionContext,
  language: Language,
): string | undefined {
  if (!step.report || !context.reportDir) return undefined;

  const s = REPORT_OUTPUT_STRINGS[language];
  const isMulti = Array.isArray(step.report);
  const heading = isMulti ? s.multiHeading : s.singleHeading;
  const appendRule = s.appendRule.replace('{step_iteration}', String(context.stepIteration));

  return [heading, s.createRule, appendRule].join('\n');
}

/**
 * Render the Workflow Context section.
 */
function renderWorkflowContext(
  step: WorkflowStep,
  context: InstructionContext,
  language: Language,
): string {
  const s = SECTION_STRINGS[language];
  const lines: string[] = [
    s.workflowContext,
    `- ${s.iteration}: ${context.iteration}/${context.maxIterations}${s.iterationWorkflowWide}`,
    `- ${s.stepIteration}: ${context.stepIteration}${s.stepIterationTimes}`,
    `- ${s.step}: ${step.name}`,
  ];

  return lines.join('\n');
}

/**
 * Render report info for the Workflow Context section.
 * Used only by buildReportInstruction() (phase 2).
 */
function renderReportContext(
  report: string | ReportConfig[] | ReportObjectConfig,
  reportDir: string,
  language: Language,
): string {
  const s = SECTION_STRINGS[language];
  const lines: string[] = [
    `- ${s.reportDirectory}: ${reportDir}/`,
  ];

  if (typeof report === 'string') {
    lines.push(`- ${s.reportFile}: ${reportDir}/${report}`);
  } else if (isReportObjectConfig(report)) {
    lines.push(`- ${s.reportFile}: ${reportDir}/${report.name}`);
  } else {
    lines.push(`- ${s.reportFiles}:`);
    for (const file of report) {
      lines.push(`  - ${file.label}: ${reportDir}/${file.path}`);
    }
  }

  return lines.join('\n');
}

/**
 * Replace template placeholders in the instruction_template body.
 *
 * These placeholders may still be used in instruction_template for
 * backward compatibility or special cases.
 */
function replaceTemplatePlaceholders(
  template: string,
  step: WorkflowStep,
  context: InstructionContext,
): string {
  let result = template;

  // These placeholders are also covered by auto-injected sections
  // (User Request, Previous Response, Additional User Inputs), but kept here
  // for backward compatibility with workflows that still embed them in
  // instruction_template (e.g., research.yaml, magi.yaml).
  // New workflows should NOT use {task} or {user_inputs} in instruction_template
  // since they are auto-injected as separate sections.

  // Replace {task}
  result = result.replace(/\{task\}/g, escapeTemplateChars(context.task));

  // Replace {iteration}, {max_iterations}, and {step_iteration}
  result = result.replace(/\{iteration\}/g, String(context.iteration));
  result = result.replace(/\{max_iterations\}/g, String(context.maxIterations));
  result = result.replace(/\{step_iteration\}/g, String(context.stepIteration));

  // Replace {previous_response}
  if (step.passPreviousResponse) {
    if (context.previousOutput) {
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

  // Replace {report_dir}
  if (context.reportDir) {
    result = result.replace(/\{report_dir\}/g, context.reportDir);
  }

  // Replace {report:filename} with reportDir/filename
  if (context.reportDir) {
    result = result.replace(/\{report:([^}]+)\}/g, (_match, filename: string) => {
      return `${context.reportDir}/${filename}`;
    });
  }

  return result;
}

/**
 * Build instruction from template with context values.
 *
 * Generates a complete instruction by auto-injecting standard sections
 * around the step-specific instruction_template content:
 *
 * 1. Execution Context (working directory, rules) — always
 * 2. Workflow Context (iteration, step, report info) — always
 * 3. User Request ({task}) — unless template contains {task}
 * 4. Previous Response — if passPreviousResponse and has content, unless template contains {previous_response}
 * 5. Additional User Inputs — unless template contains {user_inputs}
 * 6. Instructions header + instruction_template content — always
 * 7. Status Output Rules — when step has tag-based rules (not all ai()/aggregate)
 *
 * Template placeholders ({task}, {previous_response}, etc.) are still replaced
 * within the instruction_template body for backward compatibility.
 * When a placeholder is present in the template, the corresponding
 * auto-injected section is skipped to avoid duplication.
 */
export function buildInstruction(
  step: WorkflowStep,
  context: InstructionContext,
): string {
  const language = context.language ?? 'en';
  const s = SECTION_STRINGS[language];
  const sections: string[] = [];

  // 1. Execution context metadata (working directory + rules + edit permission)
  const metadata = buildExecutionMetadata(context, step.edit);
  sections.push(renderExecutionMetadata(metadata));

  // 2. Workflow Context (iteration, step, report info)
  sections.push(renderWorkflowContext(step, context, language));

  // Skip auto-injection for sections whose placeholders exist in the template,
  // to avoid duplicate content. Templates using placeholders handle their own layout.
  const tmpl = step.instructionTemplate;
  const hasTaskPlaceholder = tmpl.includes('{task}');
  const hasPreviousResponsePlaceholder = tmpl.includes('{previous_response}');
  const hasUserInputsPlaceholder = tmpl.includes('{user_inputs}');

  // 3. User Request (skip if template embeds {task} directly)
  if (!hasTaskPlaceholder) {
    sections.push(`${s.userRequest}\n${escapeTemplateChars(context.task)}`);
  }

  // 4. Previous Response (skip if template embeds {previous_response} directly)
  if (step.passPreviousResponse && context.previousOutput && !hasPreviousResponsePlaceholder) {
    sections.push(
      `${s.previousResponse}\n${escapeTemplateChars(context.previousOutput.content)}`,
    );
  }

  // 5. Additional User Inputs (skip if template embeds {user_inputs} directly)
  if (!hasUserInputsPlaceholder) {
    const userInputsStr = context.userInputs.join('\n');
    sections.push(`${s.additionalUserInputs}\n${escapeTemplateChars(userInputsStr)}`);
  }

  // 6. Instructions header + instruction_template content
  const processedTemplate = replaceTemplatePlaceholders(
    step.instructionTemplate,
    step,
    context,
  );
  sections.push(`${s.instructions}\n${processedTemplate}`);

  // 7. Status Output Rules (for tag-based detection in Phase 1)
  // Skip if all rules are ai() or aggregate conditions (no tags needed)
  if (hasTagBasedRules(step)) {
    const statusRulesPrompt = generateStatusRulesFromRules(step.name, step.rules!, language);
    sections.push(statusRulesPrompt);
  }

  return sections.join('\n\n');
}

/** Localized strings for report phase execution rules */
const REPORT_PHASE_STRINGS = {
  en: {
    noSourceEdit: '**Do NOT modify project source files.** Only output report files.',
    instructionBody: 'Output the results of your previous work as a report.',
  },
  ja: {
    noSourceEdit: '**プロジェクトのソースファイルを変更しないでください。** レポートファイルのみ出力してください。',
    instructionBody: '前のステップの作業結果をレポートとして出力してください。',
  },
} as const;

/**
 * Context for building report phase instruction.
 */
export interface ReportInstructionContext {
  /** Working directory */
  cwd: string;
  /** Report directory path */
  reportDir: string;
  /** Step iteration (for {step_iteration} replacement) */
  stepIteration: number;
  /** Language */
  language?: Language;
}

/**
 * Build instruction for phase 2 (report output).
 *
 * Separate from buildInstruction() — only includes:
 * - Execution Context (cwd + rules)
 * - Workflow Context (report info only)
 * - Report output instruction + format
 *
 * Does NOT include: User Request, Previous Response, User Inputs,
 * Status rules, instruction_template.
 */
export function buildReportInstruction(
  step: WorkflowStep,
  context: ReportInstructionContext,
): string {
  if (!step.report) {
    throw new Error(`buildReportInstruction called for step "${step.name}" which has no report config`);
  }

  const language = context.language ?? 'en';
  const s = SECTION_STRINGS[language];
  const r = REPORT_PHASE_STRINGS[language];
  const m = METADATA_STRINGS[language];
  const sections: string[] = [];

  // 1. Execution Context
  const execLines = [
    m.heading,
    `- ${m.workingDirectory}: ${context.cwd}`,
    '',
    m.rulesHeading,
    `- ${m.noCommit}`,
    `- ${m.noCd}`,
    `- ${r.noSourceEdit}`,
  ];
  if (m.note) {
    execLines.push('');
    execLines.push(m.note);
  }
  execLines.push('');
  sections.push(execLines.join('\n'));

  // 2. Workflow Context (report info only)
  const workflowLines = [
    s.workflowContext,
    renderReportContext(step.report, context.reportDir, language),
  ];
  sections.push(workflowLines.join('\n'));

  // 3. Instructions + report output instruction + format
  const instrParts: string[] = [
    `${s.instructions}`,
    r.instructionBody,
  ];

  // Report output instruction (auto-generated or explicit order)
  const reportContext: InstructionContext = {
    task: '',
    iteration: 0,
    maxIterations: 0,
    stepIteration: context.stepIteration,
    cwd: context.cwd,
    projectCwd: context.cwd,
    userInputs: [],
    reportDir: context.reportDir,
    language,
  };

  if (isReportObjectConfig(step.report) && step.report.order) {
    const processedOrder = replaceTemplatePlaceholders(step.report.order.trimEnd(), step, reportContext);
    instrParts.push('');
    instrParts.push(processedOrder);
  } else {
    const reportInstruction = renderReportOutputInstruction(step, reportContext, language);
    if (reportInstruction) {
      instrParts.push('');
      instrParts.push(reportInstruction);
    }
  }

  // Report format
  if (isReportObjectConfig(step.report) && step.report.format) {
    const processedFormat = replaceTemplatePlaceholders(step.report.format.trimEnd(), step, reportContext);
    instrParts.push('');
    instrParts.push(processedFormat);
  }

  sections.push(instrParts.join('\n'));

  return sections.join('\n\n');
}

/** Localized strings for status judgment phase (Phase 3) */
const STATUS_JUDGMENT_STRINGS = {
  en: {
    header: 'Review your work results and determine the status. Do NOT perform any additional work.',
  },
  ja: {
    header: '作業結果を振り返り、ステータスを判定してください。追加の作業は行わないでください。',
  },
} as const;

/**
 * Context for building status judgment instruction (Phase 3).
 */
export interface StatusJudgmentContext {
  /** Language */
  language?: Language;
}

/**
 * Build instruction for Phase 3 (status judgment).
 *
 * Resumes the agent session and asks it to evaluate its work
 * and output the appropriate status tag. No tools are allowed.
 *
 * Includes:
 * - Header instruction (review and determine status)
 * - Status rules (criteria table + output format) from generateStatusRulesFromRules()
 */
export function buildStatusJudgmentInstruction(
  step: WorkflowStep,
  context: StatusJudgmentContext,
): string {
  if (!step.rules || step.rules.length === 0) {
    throw new Error(`buildStatusJudgmentInstruction called for step "${step.name}" which has no rules`);
  }

  const language = context.language ?? 'en';
  const s = STATUS_JUDGMENT_STRINGS[language];
  const sections: string[] = [];

  // Header
  sections.push(s.header);

  // Status rules (criteria table + output format)
  const generatedPrompt = generateStatusRulesFromRules(step.name, step.rules, language);
  sections.push(generatedPrompt);

  return sections.join('\n\n');
}
