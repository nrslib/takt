/**
 * Phase 1 instruction builder
 *
 * Builds the instruction string for main agent execution.
 * Assembles template variables and renders a single complete template.
 */

import type { PieceMovement, Language, OutputContractItem, OutputContractEntry } from '../../models/types.js';
import type { InstructionContext } from './instruction-context.js';
import { buildEditRule } from './instruction-context.js';
import { escapeTemplateChars, replaceTemplatePlaceholders } from './escape.js';
import { loadTemplate } from '../../../shared/prompts/index.js';

const CONTEXT_MAX_CHARS = 2000;

interface PreparedContextBlock {
  readonly content: string;
  readonly truncated: boolean;
}

function trimContextContent(content: string): PreparedContextBlock {
  if (content.length <= CONTEXT_MAX_CHARS) {
    return { content, truncated: false };
  }
  return {
    content: `${content.slice(0, CONTEXT_MAX_CHARS)}\n...TRUNCATED...`,
    truncated: true,
  };
}

function renderConflictNotice(): string {
  return 'If prompt content conflicts with source files, source files take precedence.';
}

function prepareKnowledgeContent(content: string, sourcePath?: string): string {
  const prepared = trimContextContent(content);
  const lines: string[] = [prepared.content];
  if (prepared.truncated && sourcePath) {
    lines.push(
      '',
      `Knowledge is truncated. You MUST consult the source files before making decisions. Source: ${sourcePath}`,
    );
  }
  if (sourcePath) {
    lines.push('', `Knowledge Source: ${sourcePath}`);
  }
  lines.push('', renderConflictNotice());
  return lines.join('\n');
}

function preparePolicyContent(content: string, sourcePath?: string): string {
  const prepared = trimContextContent(content);
  const lines: string[] = [prepared.content];
  if (prepared.truncated && sourcePath) {
    lines.push(
      '',
      `Policy is authoritative. If truncated, you MUST read the full policy file and follow it strictly. Source: ${sourcePath}`,
    );
  }
  if (sourcePath) {
    lines.push('', `Policy Source: ${sourcePath}`);
  }
  lines.push('', renderConflictNotice());
  return lines.join('\n');
}

function preparePreviousResponseContent(content: string, sourcePath?: string): string {
  const prepared = trimContextContent(content);
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

    // Instructions (instruction_template processed)
    const instructions = replaceTemplatePlaceholders(
      this.step.instructionTemplate,
      this.step,
      {
        ...this.context,
        previousResponseText: previousResponsePrepared || undefined,
      },
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
    const policyJoined = hasPolicy ? policyContents!.join('\n\n---\n\n') : '';
    const policyContent = hasPolicy
      ? preparePolicyContent(policyJoined, this.context.policySourcePath)
      : '';

    // Knowledge injection (domain-specific knowledge, no reminder needed)
    const knowledgeContents = this.context.knowledgeContents ?? this.step.knowledgeContents;
    const hasKnowledge = !!(knowledgeContents && knowledgeContents.length > 0);
    const knowledgeJoined = hasKnowledge ? knowledgeContents!.join('\n\n---\n\n') : '';
    const knowledgeContent = hasKnowledge
      ? prepareKnowledgeContent(knowledgeJoined, this.context.knowledgeSourcePath)
      : '';

    // Quality gates injection (AI directives for movement completion)
    const hasQualityGates = !!(this.step.qualityGates && this.step.qualityGates.length > 0);
    const qualityGatesContent = hasQualityGates
      ? this.step.qualityGates!.map(gate => `- ${gate}`).join('\n')
      : '';

    return loadTemplate('perform_phase1_message', language, {
      workingDirectory: this.context.cwd,
      editRule,
      pieceName,
      pieceDescription,
      hasPieceDescription,
      pieceStructure,
      iteration: `${this.context.iteration}/${this.context.maxMovements}`,
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
      hasQualityGates,
      qualityGatesContent,
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
    const fileName = isOutputContractItem(entry) ? entry.name : entry.path;
    lines.push(`- ${reportFile}: ${reportDir}/${fileName}`);
  } else {
    lines.push(`- ${reportFiles}:`);
    for (const entry of outputContracts) {
      if (isOutputContractItem(entry)) {
        lines.push(`  - ${entry.name}: ${reportDir}/${entry.name}`);
      } else {
        lines.push(`  - ${entry.label}: ${reportDir}/${entry.path}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Generate report output instructions from movement's output contracts.
 * Returns empty string if movement has no output contracts or no reportDir.
 */
export function renderReportOutputInstruction(
  step: PieceMovement,
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
