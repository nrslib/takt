/**
 * Instruction template builder for workflow steps
 *
 * Builds the instruction string for agent execution by:
 * 1. Auto-injecting standard sections (Execution Context, Workflow Context,
 *    User Request, Previous Response, Additional User Inputs, Instructions header)
 * 2. Replacing template placeholders with actual values
 * 3. Appending auto-generated status rules from workflow rules
 */

import type { WorkflowStep, WorkflowRule, AgentResponse, Language, ReportConfig, ReportObjectConfig } from '../models/types.js';


/**
 * Context for building instruction from template.
 */
export interface InstructionContext {
  /** The main task/prompt */
  task: string;
  /** Current iteration number (workflow-wide turn count) */
  iteration: number;
  /** Maximum iterations allowed */
  maxIterations: number;
  /** Current step's iteration number (how many times this step has been executed) */
  stepIteration: number;
  /** Working directory (agent work dir, may be a clone) */
  cwd: string;
  /** Project root directory (where .takt/ lives). Defaults to cwd. */
  projectCwd?: string;
  /** User inputs accumulated during workflow */
  userInputs: string[];
  /** Previous step output if available */
  previousOutput?: AgentResponse;
  /** Report directory path */
  reportDir?: string;
  /** Language for metadata rendering. Defaults to 'en'. */
  language?: Language;
}

/** Execution environment metadata prepended to agent instructions */
export interface ExecutionMetadata {
  /** The agent's working directory (may be a clone) */
  readonly workingDirectory: string;
  /** Language for metadata rendering */
  readonly language: Language;
  /** Whether file editing is allowed for this step (undefined = no prompt) */
  readonly edit?: boolean;
}

/**
 * Build execution metadata from instruction context and step config.
 *
 * Pure function: (InstructionContext, edit?) → ExecutionMetadata.
 */
export function buildExecutionMetadata(context: InstructionContext, edit?: boolean): ExecutionMetadata {
  return {
    workingDirectory: context.cwd,
    language: context.language ?? 'en',
    edit,
  };
}

/** Localized strings for status rules header */
const STATUS_RULES_HEADER_STRINGS = {
  en: {
    heading: '# ⚠️ Required: Status Output Rules ⚠️',
    warning: '**The workflow will stop without this tag.**',
    instruction: 'Your final output MUST include a status tag following the rules below.',
  },
  ja: {
    heading: '# ⚠️ 必須: ステータス出力ルール ⚠️',
    warning: '**このタグがないとワークフローが停止します。**',
    instruction: '最終出力には必ず以下のルールに従ったステータスタグを含めてください。',
  },
} as const;

/**
 * Render status rules header.
 * Prepended to auto-generated status rules from workflow rules.
 */
export function renderStatusRulesHeader(language: Language): string {
  const strings = STATUS_RULES_HEADER_STRINGS[language];
  return [strings.heading, '', strings.warning, strings.instruction, ''].join('\n');
}

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

/** Localized strings for execution metadata rendering */
const METADATA_STRINGS = {
  en: {
    heading: '## Execution Context',
    workingDirectory: 'Working Directory',
    rulesHeading: '## Execution Rules',
    noCommit: '**Do NOT run git commit.** Commits are handled automatically by the system after workflow completion.',
    noCd: '**Do NOT use `cd` in Bash commands.** Your working directory is already set correctly. Run commands directly without changing directories.',
    editEnabled: '**Editing is ENABLED for this step.** You may create, modify, and delete files as needed to fulfill the user\'s request.',
    editDisabled: '**Editing is DISABLED for this step.** Do NOT create, modify, or delete any project source files. You may only read/search code and write to report files in the Report Directory.',
    note: 'Note: This section is metadata. Follow the language used in the rest of the prompt.',
  },
  ja: {
    heading: '## 実行コンテキスト',
    workingDirectory: '作業ディレクトリ',
    rulesHeading: '## 実行ルール',
    noCommit: '**git commit を実行しないでください。** コミットはワークフロー完了後にシステムが自動で行います。',
    noCd: '**Bashコマンドで `cd` を使用しないでください。** 作業ディレクトリは既に正しく設定されています。ディレクトリを変更せずにコマンドを実行してください。',
    editEnabled: '**このステップでは編集が許可されています。** ユーザーの要求に応じて、ファイルの作成・変更・削除を行ってください。',
    editDisabled: '**このステップでは編集が禁止されています。** プロジェクトのソースファイルを作成・変更・削除しないでください。コードの読み取り・検索と、Report Directoryへのレポート出力のみ行えます。',
    note: '',
  },
} as const;

/**
 * Render execution metadata as a markdown string.
 *
 * Pure function: ExecutionMetadata → string.
 * Always includes heading + Working Directory + Execution Rules.
 * Language determines the output language; 'en' includes a note about language consistency.
 */
export function renderExecutionMetadata(metadata: ExecutionMetadata): string {
  const strings = METADATA_STRINGS[metadata.language];
  const lines = [
    strings.heading,
    `- ${strings.workingDirectory}: ${metadata.workingDirectory}`,
    '',
    strings.rulesHeading,
    `- ${strings.noCommit}`,
    `- ${strings.noCd}`,
  ];
  if (metadata.edit === true) {
    lines.push(`- ${strings.editEnabled}`);
  } else if (metadata.edit === false) {
    lines.push(`- ${strings.editDisabled}`);
  }
  if (strings.note) {
    lines.push('');
    lines.push(strings.note);
  }
  lines.push('');
  return lines.join('\n');
}

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

  // Report info (only if step has report config AND reportDir is available)
  if (step.report && context.reportDir) {
    lines.push(`- ${s.reportDirectory}: ${context.reportDir}/`);

    if (typeof step.report === 'string') {
      // Single file (string form)
      lines.push(`- ${s.reportFile}: ${context.reportDir}/${step.report}`);
    } else if (isReportObjectConfig(step.report)) {
      // Object form (name + order + format)
      lines.push(`- ${s.reportFile}: ${context.reportDir}/${step.report.name}`);
    } else {
      // Multiple files (ReportConfig[] form)
      lines.push(`- ${s.reportFiles}:`);
      for (const file of step.report as ReportConfig[]) {
        lines.push(`  - ${file.label}: ${context.reportDir}/${file.path}`);
      }
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
 * 7. Status Output Rules — if rules exist
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

  // 6a. Report order (prepended before instruction_template, from ReportObjectConfig)
  if (step.report && isReportObjectConfig(step.report) && step.report.order) {
    const processedOrder = replaceTemplatePlaceholders(step.report.order.trimEnd(), step, context);
    sections.push(processedOrder);
  }

  // 6b. Instructions header + instruction_template content
  const processedTemplate = replaceTemplatePlaceholders(
    step.instructionTemplate,
    step,
    context,
  );
  sections.push(`${s.instructions}\n${processedTemplate}`);

  // 6c. Report format (appended after instruction_template, from ReportObjectConfig)
  if (step.report && isReportObjectConfig(step.report) && step.report.format) {
    const processedFormat = replaceTemplatePlaceholders(step.report.format.trimEnd(), step, context);
    sections.push(processedFormat);
  }

  // 7. Status rules (auto-generated from rules)
  if (step.rules && step.rules.length > 0) {
    const statusHeader = renderStatusRulesHeader(language);
    const generatedPrompt = generateStatusRulesFromRules(step.name, step.rules, language);
    sections.push(`${statusHeader}\n${generatedPrompt}`);
  }

  return sections.join('\n\n');
}
