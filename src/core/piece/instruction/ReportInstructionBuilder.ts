/**
 * Phase 2 instruction builder (report output)
 *
 * Builds the instruction for the report output phase.
 * Assembles template variables and renders a single complete template.
 */

import type { PieceMovement, Language } from '../../models/types.js';
import type { InstructionContext } from './instruction-context.js';
import { replaceTemplatePlaceholders } from './escape.js';
import { isOutputContractItem, renderReportContext, renderReportOutputInstruction } from './InstructionBuilder.js';
import { loadTemplate } from '../../../shared/prompts/index.js';

/**
 * Context for building report phase instruction.
 */
export interface ReportInstructionContext {
  /** Working directory */
  cwd: string;
  /** Report directory path */
  reportDir: string;
  /** Movement iteration (for {movement_iteration} replacement) */
  movementIteration: number;
  /** Language */
  language?: Language;
  /** Target report file name (when generating a single report) */
  targetFile?: string;
}

/**
 * Builds Phase 2 (report output) instructions.
 *
 * Renders a single complete template with all variables.
 */
export class ReportInstructionBuilder {
  constructor(
    private readonly step: PieceMovement,
    private readonly context: ReportInstructionContext,
  ) {}

  build(): string {
    if (!this.step.outputContracts || this.step.outputContracts.length === 0) {
      throw new Error(`ReportInstructionBuilder called for movement "${this.step.name}" which has no output contracts`);
    }

    const language = this.context.language ?? 'en';

    // Build report context for Piece Context section
    let reportContext: string;
    if (this.context.targetFile) {
      reportContext = `- Report Directory: ${this.context.reportDir}/\n- Report File: ${this.context.reportDir}/${this.context.targetFile}`;
    } else {
      reportContext = renderReportContext(this.step.outputContracts, this.context.reportDir);
    }

    // Build report output instruction
    let reportOutput = '';
    let hasReportOutput = false;
    const instrContext: InstructionContext = {
      task: '',
      iteration: 0,
      maxMovements: 0,
      movementIteration: this.context.movementIteration,
      cwd: this.context.cwd,
      projectCwd: this.context.cwd,
      userInputs: [],
      reportDir: this.context.reportDir,
      language,
    };

    // Check for order instruction in first output contract item
    const firstContract = this.step.outputContracts[0];
    if (firstContract && isOutputContractItem(firstContract) && firstContract.order) {
      reportOutput = replaceTemplatePlaceholders(firstContract.order.trimEnd(), this.step, instrContext);
      hasReportOutput = true;
    } else if (!this.context.targetFile) {
      const output = renderReportOutputInstruction(this.step, instrContext, language);
      if (output) {
        reportOutput = output;
        hasReportOutput = true;
      }
    }

    // Build output contract (from first item's format)
    let outputContract = '';
    let hasOutputContract = false;
    if (firstContract && isOutputContractItem(firstContract) && firstContract.format) {
      outputContract = replaceTemplatePlaceholders(firstContract.format.trimEnd(), this.step, instrContext);
      hasOutputContract = true;
    }

    return loadTemplate('perform_phase2_message', language, {
      workingDirectory: this.context.cwd,
      reportContext,
      hasReportOutput,
      reportOutput,
      hasOutputContract,
      outputContract,
    });
  }
}
