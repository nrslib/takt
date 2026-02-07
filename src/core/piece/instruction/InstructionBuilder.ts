/**
 * Phase 1 instruction builder
 *
 * Builds the instruction string for main agent execution.
 * Assembles template variables and renders a single complete template.
 */

import type { PieceMovement, Language, ReportConfig, ReportObjectConfig } from '../../models/types.js';
import type { InstructionContext } from './instruction-context.js';
import { buildEditRule } from './instruction-context.js';
import { escapeTemplateChars, replaceTemplatePlaceholders } from './escape.js';
import { loadTemplate } from '../../../shared/prompts/index.js';

/**
 * Check if a report config is the object form (ReportObjectConfig).
 */
export function isReportObjectConfig(report: string | ReportConfig[] | ReportObjectConfig): report is ReportObjectConfig {
  return typeof report === 'object' && !Array.isArray(report) && 'name' in report;
}

/**
 * Builds Phase 1 instructions for agent execution.
 *
 * Stateless builder — all data is passed via constructor context.
 * Renders a single complete template with all variables.
 */
export class InstructionBuilder {
  constructor(
    private readonly step: PieceMovement,
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

    // Piece structure (loop expansion done in code)
    const pieceStructure = this.buildPieceStructure(language);

    // Report info
    const hasReport = !!(this.step.report && this.context.reportDir);
    let reportInfo = '';
    let phaseNote = '';
    if (hasReport && this.step.report && this.context.reportDir) {
      reportInfo = renderReportContext(this.step.report, this.context.reportDir);
      phaseNote = language === 'ja'
        ? '**注意:** これはPhase 1（本来の作業）です。作業完了後、Phase 2で自動的にレポートを生成します。'
        : '**Note:** This is Phase 1 (main work). After you complete your work, Phase 2 will automatically generate the report based on your findings.';
    }

    // Skip auto-injection for sections whose placeholders exist in the template
    const tmpl = this.step.instructionTemplate;
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
    const previousResponse = hasPreviousResponse && this.context.previousOutput
      ? escapeTemplateChars(this.context.previousOutput.content)
      : '';

    // User Inputs
    const hasUserInputs = !hasUserInputsPlaceholder;
    const userInputs = hasUserInputs
      ? escapeTemplateChars(this.context.userInputs.join('\n'))
      : '';

    // Instructions (instruction_template processed)
    const instructions = replaceTemplatePlaceholders(
      this.step.instructionTemplate,
      this.step,
      this.context,
    );

    // Piece name and description
    const pieceName = this.context.pieceName ?? '';
    const pieceDescription = this.context.pieceDescription ?? '';
    const hasPieceDescription = !!pieceDescription;

    // Retry note
    const hasRetryNote = !!this.context.retryNote;
    const retryNote = hasRetryNote ? escapeTemplateChars(this.context.retryNote!) : '';

    // Policy injection (top + bottom reminder per "Lost in the Middle" research)
    const policyContents = this.context.policyContents ?? this.step.policyContents;
    const hasPolicy = !!(policyContents && policyContents.length > 0);
    const policyContent = hasPolicy ? policyContents!.join('\n\n---\n\n') : '';

    // Knowledge injection (domain-specific knowledge, no reminder needed)
    const knowledgeContents = this.context.knowledgeContents ?? this.step.knowledgeContents;
    const hasKnowledge = !!(knowledgeContents && knowledgeContents.length > 0);
    const knowledgeContent = hasKnowledge ? knowledgeContents!.join('\n\n---\n\n') : '';

    return loadTemplate('perform_phase1_message', language, {
      workingDirectory: this.context.cwd,
      editRule,
      pieceName,
      pieceDescription,
      hasPieceDescription,
      pieceStructure,
      iteration: `${this.context.iteration}/${this.context.maxIterations}`,
      movementIteration: String(this.context.movementIteration),
      movement: this.step.name,
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
      instructions,
    });
  }

  /**
   * Build the piece structure display string.
   * Returns empty string if no piece movements are available.
   */
  private buildPieceStructure(language: Language): string {
    if (!this.context.pieceMovements || this.context.pieceMovements.length === 0) {
      return '';
    }

    const currentMovementMarker = language === 'ja' ? '現在' : 'current';
    const structureHeader = language === 'ja'
      ? `このピースは${this.context.pieceMovements.length}ムーブメントで構成されています:`
      : `This piece consists of ${this.context.pieceMovements.length} movements:`;
    const movementLines = this.context.pieceMovements.map((ws, index) => {
      const isCurrent = index === this.context.currentMovementIndex;
      const marker = isCurrent ? ` ← ${currentMovementMarker}` : '';
      const desc = ws.description ? `（${ws.description}）` : '';
      return `- Movement ${index + 1}: ${ws.name}${desc}${marker}`;
    });
    return [structureHeader, ...movementLines].join('\n');
  }
}

/**
 * Render report context info for Piece Context section.
 * Used by InstructionBuilder and ReportInstructionBuilder.
 */
export function renderReportContext(
  report: string | ReportConfig[] | ReportObjectConfig,
  reportDir: string,
): string {
  const reportDirectory = 'Report Directory';
  const reportFile = 'Report File';
  const reportFiles = 'Report Files';

  const lines: string[] = [
    `- ${reportDirectory}: ${reportDir}/`,
  ];

  if (typeof report === 'string') {
    lines.push(`- ${reportFile}: ${reportDir}/${report}`);
  } else if (isReportObjectConfig(report)) {
    lines.push(`- ${reportFile}: ${reportDir}/${report.name}`);
  } else {
    lines.push(`- ${reportFiles}:`);
    for (const file of report) {
      lines.push(`  - ${file.label}: ${reportDir}/${file.path}`);
    }
  }

  return lines.join('\n');
}

/**
 * Generate report output instructions from movement's report config.
 * Returns empty string if movement has no report or no reportDir.
 */
export function renderReportOutputInstruction(
  step: PieceMovement,
  context: InstructionContext,
  language: Language,
): string {
  if (!step.report || !context.reportDir) return '';

  const isMulti = Array.isArray(step.report);

  let heading: string;
  let createRule: string;
  let appendRule: string;

  if (language === 'ja') {
    heading = isMulti
      ? '**レポート出力:** Report Files に出力してください。'
      : '**レポート出力:** `Report File` に出力してください。';
    createRule = '- ファイルが存在しない場合: 新規作成';
    appendRule = `- ファイルが存在する場合: \`## Iteration ${context.movementIteration}\` セクションを追記`;
  } else {
    heading = isMulti
      ? '**Report output:** Output to the `Report Files` specified above.'
      : '**Report output:** Output to the `Report File` specified above.';
    createRule = '- If file does not exist: Create new file';
    appendRule = `- If file exists: Append with \`## Iteration ${context.movementIteration}\` section`;
  }

  return `${heading}\n${createRule}\n${appendRule}`;
}
