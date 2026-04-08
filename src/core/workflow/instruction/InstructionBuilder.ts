/**
 * Phase 1 instruction builder
 *
 * Builds the instruction string for main agent execution.
 * Assembles template variables and renders a single complete template.
 *
 * Truncation and context preparation are delegated to faceted-prompting.
 * preparePreviousResponseContent is TAKT-specific and stays here.
 */

import type { WorkflowStep, Language, OutputContractItem, OutputContractEntry } from '../../models/types.js';
import type { InstructionContext } from './instruction-context.js';
import { buildEditRule } from './instruction-context.js';
import { escapeTemplateChars, replaceTemplatePlaceholders } from './escape.js';
import { loadTemplate } from '../../../shared/prompts/index.js';
import {
  trimContextContent,
  renderConflictNotice,
  prepareKnowledgeContent as prepareKnowledgeContentGeneric,
  preparePolicyContent as preparePolicyContentGeneric,
} from 'faceted-prompting';

const CONTEXT_MAX_CHARS = 2000;

function prepareKnowledgeContent(content: string, sourcePath?: string): string {
  return prepareKnowledgeContentGeneric(content, CONTEXT_MAX_CHARS, sourcePath);
}

function preparePolicyContent(content: string, sourcePath?: string): string {
  return preparePolicyContentGeneric(content, CONTEXT_MAX_CHARS, sourcePath);
}

function preparePreviousResponseContent(content: string, sourcePath?: string): string {
  const prepared = trimContextContent(content, CONTEXT_MAX_CHARS);
  const lines: string[] = [prepared.content];
  if (prepared.truncated && sourcePath) {
    lines.push('', `Previous Response is truncated. Source: ${sourcePath}`);
  }
  if (sourcePath) {
    lines.push('', `Source: ${sourcePath}`);
  }
  lines.push('', renderConflictNotice());
  return lines.join('\n');
}

/**
 * Check if an output contract entry is the item form (OutputContractItem).
 */
export function isOutputContractItem(entry: OutputContractEntry): entry is OutputContractItem {
  return 'name' in entry;
}

/**
 * Builds Phase 1 instructions for agent execution.
 *
 * Stateless builder — all data is passed via constructor context.
 * Renders a single complete template with all variables.
 */
export class InstructionBuilder {
  constructor(
    private readonly step: WorkflowStep,
    private readonly context: InstructionContext,
  ) {}

  /**
   * Build the complete instruction string.
   *
   * Assembles all template variables and renders the Phase 1 template
   * in a single loadTemplate() call.
   */
  build(): string {
    const language = this.context.language ?? 'en';

    // Execution context variables
    const editRule = buildEditRule(this.step.edit, language);

    // Workflow structure (loop expansion done in code)
    const workflowStructure = this.buildWorkflowStructure(language);

    // Report info (from output contracts)
    const hasReport = !!(this.step.outputContracts && this.step.outputContracts.length > 0 && this.context.reportDir);
    let reportInfo = '';
    let phaseNote = '';
    if (hasReport && this.step.outputContracts && this.context.reportDir) {
      reportInfo = renderReportContext(this.step.outputContracts, this.context.reportDir);
      phaseNote = language === 'ja'
        ? '**注意:** これはPhase 1（本来の作業）です。作業完了後、Phase 2で自動的にレポートを生成します。'
        : '**Note:** This is Phase 1 (main work). After you complete your work, Phase 2 will automatically generate the report based on your findings.';
    }

    // Skip auto-injection for sections whose placeholders exist in the template
    const tmpl = this.step.instruction;
    const hasTaskPlaceholder = tmpl.includes('{task}');
    const hasPreviousResponsePlaceholder = tmpl.includes('{previous_response}');
    const hasUserInputsPlaceholder = tmpl.includes('{user_inputs}');

    // User Request
    const hasTaskSection = !hasTaskPlaceholder;
    const userRequest = hasTaskSection ? escapeTemplateChars(this.context.task) : '';

    // Previous Response
    const hasPreviousResponse = !!(
      this.step.passPreviousResponse &&
      this.context.previousOutput &&
      !hasPreviousResponsePlaceholder
    );
    const previousResponsePrepared = this.step.passPreviousResponse && this.context.previousOutput
      ? preparePreviousResponseContent(
          this.context.previousOutput.content,
          this.context.previousResponseSourcePath,
        )
      : '';
    const previousResponse = hasPreviousResponse
      ? escapeTemplateChars(previousResponsePrepared)
      : '';

    // User Inputs
    const hasUserInputs = !hasUserInputsPlaceholder;
    const userInputs = hasUserInputs
      ? escapeTemplateChars(this.context.userInputs.join('\n'))
      : '';

    // Instructions (step instruction with placeholder processing)
    const instructions = replaceTemplatePlaceholders(
      tmpl,
      this.step,
      {
        ...this.context,
        previousResponseText: previousResponsePrepared || undefined,
      },
    );

    // Workflow name and description
    const workflowName = this.context.workflowName ?? '';
    const workflowDescription = this.context.workflowDescription ?? '';
    const hasWorkflowDescription = !!workflowDescription;

    // Retry note
    const hasRetryNote = !!this.context.retryNote;
    const retryNote = hasRetryNote ? escapeTemplateChars(this.context.retryNote!) : '';

    // Policy injection (top + bottom reminder per "Lost in the Middle" research)
    const policyContents = this.context.policyContents ?? this.step.policyContents;
    const hasPolicy = !!(policyContents && policyContents.length > 0);
    const policyJoined = hasPolicy && policyContents ? policyContents.join('\n\n---\n\n') : '';
    const policyContent = hasPolicy
      ? preparePolicyContent(policyJoined, this.context.policySourcePath)
      : '';

    // Knowledge injection (domain-specific knowledge, no reminder needed)
    const knowledgeContents = this.context.knowledgeContents ?? this.step.knowledgeContents;
    const hasKnowledge = !!(knowledgeContents && knowledgeContents.length > 0);
    const knowledgeJoined = hasKnowledge && knowledgeContents ? knowledgeContents.join('\n\n---\n\n') : '';
    const knowledgeContent = hasKnowledge
      ? prepareKnowledgeContent(knowledgeJoined, this.context.knowledgeSourcePath)
      : '';

    // Quality gates injection (AI directives for step completion)
    const hasQualityGates = !!(this.step.qualityGates && this.step.qualityGates.length > 0);
    const qualityGatesContent = hasQualityGates && this.step.qualityGates
      ? this.step.qualityGates.map(gate => `- ${gate}`).join('\n')
      : '';

    return loadTemplate('perform_phase1_message', language, {
      workingDirectory: this.context.cwd,
      editRule,
      workflowName,
      workflowDescription,
      hasWorkflowDescription,
      workflowStructure,
      iteration: `${this.context.iteration}/${this.context.maxSteps}`,
      stepIteration: String(this.context.stepIteration),
      stepName: this.step.name,
      hasReport,
      reportInfo,
      phaseNote,
      hasTaskSection,
      userRequest,
      hasPreviousResponse,
      previousResponse,
      hasUserInputs,
      userInputs,
      hasRetryNote,
      retryNote,
      hasPolicy,
      policyContent,
      hasKnowledge,
      knowledgeContent,
      hasQualityGates,
      qualityGatesContent,
      instructions,
    });
  }

  /**
   * Build the workflow structure display string.
   * Returns empty string if no workflow steps are available.
   */
  private buildWorkflowStructure(language: Language): string {
    if (!this.context.workflowSteps || this.context.workflowSteps.length === 0) {
      return '';
    }

    const currentStepMarker = language === 'ja' ? '現在' : 'current';
    const structureHeader = language === 'ja'
      ? `このワークフローは${this.context.workflowSteps.length}ステップで構成されています:`
      : `This workflow consists of ${this.context.workflowSteps.length} steps:`;
    const stepLines = this.context.workflowSteps.map((ws, index) => {
      const isCurrent = index === this.context.currentStepIndex;
      const marker = isCurrent ? ` ← ${currentStepMarker}` : '';
      const desc = ws.description ? `（${ws.description}）` : '';
      return `- Step ${index + 1}: ${ws.name}${desc}${marker}`;
    });
    return [structureHeader, ...stepLines].join('\n');
  }
}

/**
 * Render report context info for Workflow Context section.
 * Used by InstructionBuilder and ReportInstructionBuilder.
 */
export function renderReportContext(
  outputContracts: OutputContractEntry[],
  reportDir: string,
): string {
  const reportDirectory = 'Report Directory';
  const reportFile = 'Report File';
  const reportFiles = 'Report Files';

  const lines: string[] = [
    `- ${reportDirectory}: ${reportDir}/`,
  ];

  if (outputContracts.length === 1) {
    const entry = outputContracts[0]!;
    const fileName = entry.name;
    lines.push(`- ${reportFile}: ${reportDir}/${fileName}`);
  } else {
    lines.push(`- ${reportFiles}:`);
    for (const entry of outputContracts) {
      lines.push(`  - ${entry.name}: ${reportDir}/${entry.name}`);
    }
  }

  return lines.join('\n');
}

/**
 * Generate report output instructions from step output contracts.
 * Returns empty string if step has no output contracts or no reportDir.
 */
export function renderReportOutputInstruction(
  step: WorkflowStep,
  context: InstructionContext,
  language: Language,
): string {
  if (!step.outputContracts || step.outputContracts.length === 0 || !context.reportDir) return '';

  const isMulti = step.outputContracts.length > 1;

  let heading: string;
  let createRule: string;
  let overwriteRule: string;

  if (language === 'ja') {
    heading = isMulti
      ? '**レポート出力:** Report Files に出力してください。'
      : '**レポート出力:** `Report File` に出力してください。';
    createRule = '- ファイルが存在しない場合: 新規作成';
    overwriteRule = '- ファイルが存在する場合: 既存内容を `logs/reports-history/` に退避し、最新内容で上書き';
  } else {
    heading = isMulti
      ? '**Report output:** Output to the `Report Files` specified above.'
      : '**Report output:** Output to the `Report File` specified above.';
    createRule = '- If file does not exist: Create new file';
    overwriteRule = '- If file exists: Move current content to `logs/reports-history/` and overwrite with latest report';
  }

  return `${heading}\n${createRule}\n${overwriteRule}`;
}
