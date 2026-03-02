/**
 * Rule evaluation logic for piece movements
 *
 * Evaluates piece movement rules to determine the matched rule index.
 * Supports tag-based detection, ai() conditions, aggregate conditions,
 * and AI judge fallback.
 */

import type {
  PieceMovement,
  PieceState,
  RuleMatchMethod,
} from '../../models/types.js';
import type { AiJudgeCaller, RuleIndexDetector } from '../types.js';
import { createLogger } from '../../../shared/utils/index.js';
import { AggregateEvaluator } from './AggregateEvaluator.js';

const log = createLogger('rule-evaluator');

export interface RuleMatch {
  index: number;
  method: RuleMatchMethod;
}

export interface RuleEvaluatorContext {
  /** Piece state (for accessing movementOutputs in aggregate evaluation) */
  state: PieceState;
  /** Working directory (for AI judge calls) */
  cwd: string;
  /** Whether interactive-only rules are enabled */
  interactive?: boolean;
  /** Rule tag index detector */
  detectRuleIndex: RuleIndexDetector;
  /** AI judge caller */
  callAiJudge: AiJudgeCaller;
}

/**
 * Evaluates rules for a piece movement to determine the next transition.
 *
 * Evaluation order (first match wins):
 * 1. Aggregate conditions: all()/any() — evaluate sub-movement results
 * 2. Tag detection from Phase 3 output
 * 3. Tag detection from Phase 1 output (fallback)
 * 4. ai() condition evaluation via AI judge
 * 5. All-conditions AI judge (final fallback)
 *
 * Returns undefined for movements without rules.
 * Throws if rules exist but no rule matched (Fail Fast).
 */
export class RuleEvaluator {
  constructor(
    private readonly step: PieceMovement,
    private readonly ctx: RuleEvaluatorContext,
  ) {}

  async evaluate(agentContent: string, tagContent: string, agentError?: string): Promise<RuleMatch | undefined> {
    if (!this.step.rules || this.step.rules.length === 0) return undefined;
    const interactiveEnabled = this.ctx.interactive === true;

    // 1. Aggregate conditions (all/any) — only meaningful for parallel parent movements
    const aggEvaluator = new AggregateEvaluator(this.step, this.ctx.state);
    const aggIndex = aggEvaluator.evaluate();
    if (aggIndex >= 0) {
      return { index: aggIndex, method: 'aggregate' };
    }

    // 2. Tag detection from Phase 3 output
    if (tagContent) {
      const ruleIndex = this.ctx.detectRuleIndex(tagContent, this.step.name);
      if (ruleIndex >= 0 && ruleIndex < this.step.rules.length) {
        const rule = this.step.rules[ruleIndex];
        if (rule?.interactiveOnly && !interactiveEnabled) {
          // Skip interactive-only rule in non-interactive mode
        } else {
          return { index: ruleIndex, method: 'phase3_tag' };
        }
      }
    }

    // 3. Tag detection from Phase 1 output (fallback)
    if (agentContent) {
      const ruleIndex = this.ctx.detectRuleIndex(agentContent, this.step.name);
      if (ruleIndex >= 0 && ruleIndex < this.step.rules.length) {
        const rule = this.step.rules[ruleIndex];
        if (rule?.interactiveOnly && !interactiveEnabled) {
          // Skip interactive-only rule in non-interactive mode
        } else {
          return { index: ruleIndex, method: 'phase1_tag' };
        }
      }
    }

    // 4. AI judge for ai() conditions only
    const aiRuleIndex = await this.evaluateAiConditions(agentContent);
    if (aiRuleIndex >= 0) {
      return { index: aiRuleIndex, method: 'ai_judge' };
    }

    // 5. AI judge for all conditions (final fallback)
    const fallbackIndex = await this.evaluateAllConditionsViaAiJudge(agentContent);
    if (fallbackIndex >= 0) {
      return { index: fallbackIndex, method: 'ai_judge_fallback' };
    }

    throw new Error(`Status not found for movement "${this.step.name}": ${agentError || 'no rule matched after all detection phases'}`);
  }

  /**
   * Evaluate ai() conditions via AI judge.
   * Returns the 0-based rule index, or -1 if no match.
   */
  private async evaluateAiConditions(agentOutput: string): Promise<number> {
    if (!this.step.rules) return -1;

    const aiConditions: { index: number; text: string }[] = [];
    for (let i = 0; i < this.step.rules.length; i++) {
      const rule = this.step.rules[i];
      if (!rule) continue;
      if (rule.interactiveOnly && this.ctx.interactive !== true) {
        continue;
      }
      if (rule.isAiCondition && rule.aiConditionText) {
        aiConditions.push({ index: i, text: rule.aiConditionText });
      }
    }

    if (aiConditions.length === 0) return -1;

    log.debug('Evaluating ai() conditions via judge', {
      movement: this.step.name,
      conditionCount: aiConditions.length,
    });

    const judgeConditions = aiConditions.map((c, i) => ({ index: i, text: c.text }));
    const judgeResult = await this.ctx.callAiJudge(agentOutput, judgeConditions, { cwd: this.ctx.cwd });

    if (judgeResult >= 0 && judgeResult < aiConditions.length) {
      const matched = aiConditions[judgeResult];
      if (!matched) return -1;
      log.debug('AI judge matched condition', {
        movement: this.step.name,
        judgeResult,
        originalRuleIndex: matched.index,
        condition: matched.text,
      });
      return matched.index;
    }

    log.debug('AI judge did not match any condition', { movement: this.step.name });
    return -1;
  }

  /**
   * Final fallback: evaluate ALL rule conditions via AI judge.
   * Returns the 0-based rule index, or -1 if no match.
   */
  private async evaluateAllConditionsViaAiJudge(agentOutput: string): Promise<number> {
    if (!this.step.rules || this.step.rules.length === 0) return -1;

    const conditions = this.step.rules
      .map((rule, i) => ({ index: i, text: rule.condition, interactiveOnly: rule.interactiveOnly }))
      .filter((rule) => this.ctx.interactive === true || !rule.interactiveOnly)
      .map((rule) => ({ index: rule.index, text: rule.text }));

    log.debug('Evaluating all conditions via AI judge (final fallback)', {
      movement: this.step.name,
      conditionCount: conditions.length,
    });

    const judgeResult = await this.ctx.callAiJudge(agentOutput, conditions, { cwd: this.ctx.cwd });

    if (judgeResult >= 0 && judgeResult < conditions.length) {
      const originalIndex = conditions[judgeResult]?.index ?? judgeResult;
      log.debug('AI judge (fallback) matched condition', {
        movement: this.step.name,
        ruleIndex: originalIndex,
        condition: conditions[judgeResult]?.text,
      });
      return originalIndex;
    }

    log.debug('AI judge (fallback) did not match any condition', { movement: this.step.name });
    return -1;
  }

}
