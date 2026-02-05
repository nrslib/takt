/**
 * Phase 3 instruction builder (status judgment)
 *
 * Builds instructions for the conductor agent to evaluate work results
 * and output the appropriate status tag. Supports report-based and
 * response-based input sources.
 *
 * Renders a single complete template combining the judgment header
 * and status rules (criteria table + output format).
 */

import type { PieceMovement, Language } from '../../models/types.js';
import { generateStatusRulesComponents } from './status-rules.js';
import { loadTemplate } from '../../../shared/prompts/index.js';

/**
 * Context for building status judgment instruction.
 */
export interface StatusJudgmentContext {
  /** Language */
  language?: Language;
  /** Whether interactive-only rules are enabled */
  interactive?: boolean;
  /** Pre-read report content (from gatherInput) */
  reportContent?: string;
  /** Last response from Phase 1 (from gatherInput) */
  lastResponse?: string;
  /** Input source type for fallback strategies */
  inputSource?: 'report' | 'response';
}

/**
 * Builds Phase 3 (status judgment) instructions.
 *
 * Renders a single complete template with all variables.
 */
export class StatusJudgmentBuilder {
  constructor(
    private readonly step: PieceMovement,
    private readonly context: StatusJudgmentContext,
  ) {}

  build(): string {
    if (!this.step.rules || this.step.rules.length === 0) {
      throw new Error(`StatusJudgmentBuilder called for movement "${this.step.name}" which has no rules`);
    }

    const language = this.context.language ?? 'en';

    const components = generateStatusRulesComponents(
      this.step.name,
      this.step.rules,
      language,
      { interactive: this.context.interactive },
    );

    // 情報源に応じた内容を構築
    const inputSource = this.context.inputSource || 'report';
    let contentToJudge = '';

    if (inputSource === 'report') {
      contentToJudge = this.buildFromReport();
    } else if (inputSource === 'response') {
      contentToJudge = this.buildFromResponse();
    }

    return loadTemplate('perform_phase3_message', language, {
      reportContent: contentToJudge,
      criteriaTable: components.criteriaTable,
      outputList: components.outputList,
      hasAppendix: components.hasAppendix,
      appendixContent: components.appendixContent,
    });
  }

  /**
   * Build judgment content from pre-read report content.
   */
  private buildFromReport(): string {
    if (!this.context.reportContent) {
      throw new Error('reportContent is required for report-based judgment');
    }
    return this.context.reportContent;
  }

  /**
   * Build judgment content from last response.
   */
  private buildFromResponse(): string {
    if (!this.context.lastResponse) {
      throw new Error('lastResponse is required for response-based judgment');
    }
    return `\n## Agent Response\n\n${this.context.lastResponse}`;
  }
}
