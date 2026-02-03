/**
 * Phase 3 instruction builder (status judgment)
 *
 * Resumes the agent session and asks it to evaluate its work
 * and output the appropriate status tag. No tools are allowed.
 *
 * Includes:
 * - Header instruction (review and determine status)
 * - Status rules (criteria table + output format)
 */

import type { WorkflowStep, Language } from '../../models/types.js';
import { generateStatusRulesFromRules } from './status-rules.js';
import { getPrompt } from '../../../shared/prompts/index.js';

/**
 * Context for building status judgment instruction.
 */
export interface StatusJudgmentContext {
  /** Language */
  language?: Language;
  /** Whether interactive-only rules are enabled */
  interactive?: boolean;
}

/**
 * Builds Phase 3 (status judgment) instructions.
 */
export class StatusJudgmentBuilder {
  constructor(
    private readonly step: WorkflowStep,
    private readonly context: StatusJudgmentContext,
  ) {}

  build(): string {
    if (!this.step.rules || this.step.rules.length === 0) {
      throw new Error(`StatusJudgmentBuilder called for step "${this.step.name}" which has no rules`);
    }

    const language = this.context.language ?? 'en';
    const sections: string[] = [];

    // Header
    sections.push(getPrompt('instruction.statusJudgment.header', language));

    // Status rules (criteria table + output format)
    const generatedPrompt = generateStatusRulesFromRules(
      this.step.name,
      this.step.rules,
      language,
      { interactive: this.context.interactive },
    );
    sections.push(generatedPrompt);

    return sections.join('\n\n');
  }
}
