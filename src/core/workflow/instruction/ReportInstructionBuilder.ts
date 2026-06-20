/**
 * Phase 2 instruction builder (report output)
 *
 * Builds the instruction for the report output phase.
 * Assembles template variables and renders a single complete template.
 */

import type { WorkflowStep, Language } from '../../models/types.js';
import type { InstructionContext } from './instruction-context.js';
import { buildGitRules } from './instruction-context.js';
import { replaceTemplatePlaceholders } from './escape.js';
import {
  isOutputContractItem,
  renderReportContext,
  renderReportOutputInstruction,
} from './InstructionBuilder.js';
import { renderFencedJsonBlock } from './fenced-json.js';
import { loadTemplate } from '../../../shared/prompts/index.js';

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
  /** Target report file name (when generating a single report) */
  targetFile?: string;
  /** Last response from Phase 1 (used when report phase retries in a new session) */
  lastResponse?: string;
  /** Finding Contract context available in tool-less report phase. */
  findingContract?: InstructionContext['findingContract'];
}

/**
 * Builds Phase 2 (report output) instructions.
 *
 * Renders a single complete template with all variables.
 */
export class ReportInstructionBuilder {
  constructor(
    private readonly step: WorkflowStep,
    private readonly context: ReportInstructionContext,
  ) {}

  build(): string {
    if (!this.step.outputContracts || this.step.outputContracts.length === 0) {
      throw new Error(`ReportInstructionBuilder called for step "${this.step.name}" which has no output contracts`);
    }

    const language = this.context.language ?? 'en';
    const gitRules = buildGitRules(this.step.allowGitCommit, language, 'phase2');
    const hasGitRules = gitRules.length > 0;

    let reportContext: string;
    if (this.context.targetFile) {
      reportContext = `- Report Directory: ${this.context.reportDir}/\n- Report File: ${this.context.reportDir}/${this.context.targetFile}`;
    } else {
      reportContext = renderReportContext(this.step.outputContracts, this.context.reportDir);
    }

    let reportOutput = '';
    let hasReportOutput = false;
    const instrContext: InstructionContext = {
      task: '',
      iteration: 0,
      maxSteps: 0,
      stepIteration: this.context.stepIteration,
      cwd: this.context.cwd,
      projectCwd: this.context.cwd,
      userInputs: [],
      reportDir: this.context.reportDir,
      language,
      findingContract: this.context.findingContract,
    };

    const targetContract = this.context.targetFile
      ? this.step.outputContracts.find((entry) => entry.name === this.context.targetFile)
      : this.step.outputContracts[0];

    if (targetContract && isOutputContractItem(targetContract) && targetContract.order) {
      reportOutput = replaceTemplatePlaceholders(targetContract.order.trimEnd(), this.step, instrContext);
      hasReportOutput = true;
    } else if (!this.context.targetFile) {
      const output = renderReportOutputInstruction(this.step, instrContext, language);
      if (output) {
        reportOutput = output;
        hasReportOutput = true;
      }
    }

    let outputContract = '';
    let hasOutputContract = false;
    if (targetContract && isOutputContractItem(targetContract) && targetContract.format) {
      outputContract = replaceTemplatePlaceholders(targetContract.format.trimEnd(), this.step, instrContext);
      hasOutputContract = true;
    }
    reportOutput = this.appendFindingContractReportInstruction(reportOutput);
    hasReportOutput = hasReportOutput || this.context.findingContract !== undefined;

    return loadTemplate('perform_phase2_message', language, {
      workingDirectory: this.context.cwd,
      hasGitRules,
      gitRules,
      reportContext,
      hasLastResponse: this.context.lastResponse != null && this.context.lastResponse.trim().length > 0,
      lastResponse: this.context.lastResponse ?? '',
      hasReportOutput,
      reportOutput,
      hasOutputContract,
      outputContract,
    });
  }

  private appendFindingContractReportInstruction(reportOutput: string): string {
    if (!this.context.findingContract) {
      return reportOutput;
    }

    const findingContractInstruction = [
      '## Finding Contract',
      `- Consolidated ledger copy: ${this.context.findingContract.ledgerCopyPath}`,
      '- Use existing finding IDs from the inline ledger summary when referring to tracked findings.',
      '- Do not assign final finding IDs.',
      '',
      'Current finding ledger IDs:',
      renderFencedJsonBlock(this.context.findingContract.reportLedgerSummary),
    ].join('\n');

    return reportOutput.length > 0
      ? [reportOutput, '', findingContractInstruction].join('\n')
      : findingContractInstruction;
  }
}
