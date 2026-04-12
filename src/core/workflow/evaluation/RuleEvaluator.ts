/**
 * Rule evaluation logic for workflow steps
 *
 * Evaluates workflow step rules to determine the matched rule index.
 * Supports tag-based detection, ai() conditions, aggregate conditions,
 * and AI judge fallback.
 */

import type {
  WorkflowStep,
  WorkflowState,
  RuleMatchMethod,
} from '../../models/types.js';
import type { StructuredCaller } from '../../../agents/structured-caller.js';
import type { ProviderType, RuleIndexDetector } from '../types.js';
import { createLogger } from '../../../shared/utils/index.js';
import { buildJudgeConditions } from '../../../agents/judge-utils.js';
import { AggregateEvaluator } from './AggregateEvaluator.js';
import { evaluateWhenExpression } from './when-evaluator.js';
import { isDeferredDeterministicCondition, isDeterministicCondition } from './rule-utils.js';

const log = createLogger('rule-evaluator');

export interface RuleMatch {
  index: number;
  method: RuleMatchMethod;
}

export interface RuleEvaluatorContext {
  /** Workflow state (for accessing stepOutputs in aggregate evaluation) */
  state: WorkflowState;
  /** Working directory (for AI judge calls) */
  cwd: string;
  /** Effective provider for the step */
  provider?: ProviderType;
  resolvedProvider?: ProviderType;
  resolvedModel?: string;
  /** Whether interactive-only rules are enabled */
  interactive?: boolean;
  /** Rule tag index detector */
  detectRuleIndex: RuleIndexDetector;
  /** Structured caller */
  structuredCaller: StructuredCaller;
}

/**
 * Evaluates rules for a workflow step to determine the next transition.
 *
 * Evaluation order (first match wins):
 * 1. Aggregate conditions: all()/any() — evaluate sub-step results
 * 2. Immediate deterministic when conditions that appear before the matched Phase 3 tag
 * 3. Tag detection from Phase 3 output
 * 4. Immediate deterministic when conditions that appear before the matched Phase 1 tag
 * 5. Tag detection from Phase 1 output (fallback)
 * 6. Immediate deterministic when conditions that appear before the matched ai() rule
 * 7. ai() condition evaluation via AI judge
 * 8. Remaining immediate deterministic when conditions
 * 9. All-conditions AI judge (final fallback)
 * 10. Deferred deterministic fallbacks (for example when: true)
 *
 * Returns undefined for steps without rules.
 * Throws if rules exist but no rule matched (Fail Fast).
 */
export class RuleEvaluator {
  constructor(
    private readonly step: WorkflowStep,
    private readonly ctx: RuleEvaluatorContext,
  ) {}

  private structuredCallerJudgeOptions(): Pick<
    RuleEvaluatorContext,
    'cwd' | 'provider' | 'resolvedProvider' | 'resolvedModel'
  > {
    return {
      cwd: this.ctx.cwd,
      provider: this.ctx.provider,
      resolvedProvider: this.ctx.resolvedProvider,
      resolvedModel: this.ctx.resolvedModel,
    };
  }

  async evaluate(agentContent: string, tagContent: string): Promise<RuleMatch | undefined> {
    if (!this.step.rules || this.step.rules.length === 0) return undefined;
    const interactiveEnabled = this.ctx.interactive === true;

    // 1. Aggregate conditions (all/any) — only meaningful for parallel parent steps
    const aggEvaluator = new AggregateEvaluator(this.step, this.ctx.state);
    const aggIndex = aggEvaluator.evaluate();
    if (aggIndex >= 0) {
      return { index: aggIndex, method: 'aggregate' };
    }

    const firstNonDeterministicIndex = this.findFirstNonDeterministicRuleIndex();
    const leadingDeterministicIndex = this.evaluateImmediateDeterministicConditions(
      0,
      firstNonDeterministicIndex >= 0 ? firstNonDeterministicIndex : undefined,
    );
    if (leadingDeterministicIndex >= 0) {
      return { index: leadingDeterministicIndex, method: 'auto_select' };
    }

    const phase3TagIndex = this.resolveTaggedRuleIndex(tagContent, interactiveEnabled);
    if (phase3TagIndex >= 0) {
      const immediateDeterministicIndex = this.evaluateImmediateDeterministicConditions(
        firstNonDeterministicIndex + 1,
        phase3TagIndex,
      );
      if (immediateDeterministicIndex >= 0) {
        return { index: immediateDeterministicIndex, method: 'auto_select' };
      }
      return { index: phase3TagIndex, method: 'phase3_tag' };
    }

    const phase1TagIndex = this.resolveTaggedRuleIndex(agentContent, interactiveEnabled);
    if (phase1TagIndex >= 0) {
      const immediateDeterministicIndex = this.evaluateImmediateDeterministicConditions(
        firstNonDeterministicIndex + 1,
        phase1TagIndex,
      );
      if (immediateDeterministicIndex >= 0) {
        return { index: immediateDeterministicIndex, method: 'auto_select' };
      }
      return { index: phase1TagIndex, method: 'phase1_tag' };
    }

    const aiRuleIndex = await this.evaluateAiConditions(agentContent);
    if (aiRuleIndex >= 0) {
      const immediateDeterministicIndex = this.evaluateImmediateDeterministicConditions(
        firstNonDeterministicIndex + 1,
        aiRuleIndex,
      );
      if (immediateDeterministicIndex >= 0) {
        return { index: immediateDeterministicIndex, method: 'auto_select' };
      }
      return { index: aiRuleIndex, method: 'ai_judge' };
    }

    const immediateDeterministicIndex = this.evaluateImmediateDeterministicConditions(
      firstNonDeterministicIndex + 1,
    );
    if (immediateDeterministicIndex >= 0) {
      return { index: immediateDeterministicIndex, method: 'auto_select' };
    }

    const fallbackIndex = await this.evaluateAllConditionsViaAiJudge(agentContent);
    if (fallbackIndex >= 0) {
      return { index: fallbackIndex, method: 'ai_judge_fallback' };
    }

    const deferredDeterministicIndex = this.evaluateDeferredDeterministicConditions();
    if (deferredDeterministicIndex >= 0) {
      return { index: deferredDeterministicIndex, method: 'auto_select' };
    }

    throw new Error(`Status not found for step "${this.step.name}": no rule matched after all detection phases`);
  }

  private resolveTaggedRuleIndex(content: string, interactiveEnabled: boolean): number {
    if (!content || !this.step.rules) return -1;

    const ruleIndex = this.ctx.detectRuleIndex(content, this.step.name);
    if (ruleIndex < 0 || ruleIndex >= this.step.rules.length) {
      return -1;
    }

    const rule = this.step.rules[ruleIndex];
    if (rule?.interactiveOnly && !interactiveEnabled) {
      return -1;
    }

    return ruleIndex;
  }

  private findFirstNonDeterministicRuleIndex(): number {
    if (!this.step.rules) return -1;

    for (let i = 0; i < this.step.rules.length; i++) {
      const rule = this.step.rules[i];
      if (!rule) continue;
      if (rule.interactiveOnly && this.ctx.interactive !== true) {
        continue;
      }
      if (rule.isAggregateCondition) {
        continue;
      }
      if (!isDeterministicCondition(rule.condition)) {
        return i;
      }
    }

    return -1;
  }

  private evaluateImmediateDeterministicConditions(startIndex = 0, endExclusive?: number): number {
    if (!this.step.rules) return -1;

    const upperBound = endExclusive ?? this.step.rules.length;
    for (let i = Math.max(startIndex, 0); i < upperBound; i++) {
      const rule = this.step.rules[i];
      if (!rule) continue;
      if (rule.interactiveOnly && this.ctx.interactive !== true) {
        continue;
      }
      if (rule.isAiCondition || rule.isAggregateCondition) {
        continue;
      }
      if (!isDeterministicCondition(rule.condition)) {
        continue;
      }
      if (isDeferredDeterministicCondition(rule.condition)) {
        continue;
      }
      if (evaluateWhenExpression(rule.condition, this.ctx.state)) {
        return i;
      }
    }

    return -1;
  }

  private evaluateDeferredDeterministicConditions(): number {
    if (!this.step.rules) return -1;

    for (let i = 0; i < this.step.rules.length; i++) {
      const rule = this.step.rules[i];
      if (!rule) continue;
      if (rule.interactiveOnly && this.ctx.interactive !== true) {
        continue;
      }
      if (rule.isAiCondition || rule.isAggregateCondition) {
        continue;
      }
      if (!isDeterministicCondition(rule.condition) || !isDeferredDeterministicCondition(rule.condition)) {
        continue;
      }
      if (evaluateWhenExpression(rule.condition, this.ctx.state)) {
        return i;
      }
    }

    return -1;
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
      step: this.step.name,
      conditionCount: aiConditions.length,
    });

    const judgeResult = await this.ctx.structuredCaller.evaluateCondition(
      agentOutput,
      aiConditions,
      this.structuredCallerJudgeOptions(),
    );
    const matched = aiConditions.find((condition) => condition.index === judgeResult);
    if (matched) {
      log.debug('AI judge matched condition', {
        step: this.step.name,
        judgeResult,
        originalRuleIndex: matched.index,
        condition: matched.text,
      });
      return judgeResult;
    }

    log.debug('AI judge did not match any condition', { step: this.step.name });
    return -1;
  }

  /**
   * Final fallback: evaluate ALL rule conditions via AI judge.
   * Returns the 0-based rule index, or -1 if no match.
   */
  private async evaluateAllConditionsViaAiJudge(agentOutput: string): Promise<number> {
    if (!this.step.rules || this.step.rules.length === 0) return -1;

    const judgeableRules = this.step.rules
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => !rule.isAggregateCondition && !isDeterministicCondition(rule.condition))
      .filter(({ rule }) => this.ctx.interactive === true || !rule.interactiveOnly);
    const conditions = buildJudgeConditions(
      judgeableRules.map(({ rule }) => rule),
      true,
      judgeableRules.map(({ index }) => index),
    );
    if (conditions.length === 0) {
      return -1;
    }

    log.debug('Evaluating all conditions via AI judge (final fallback)', {
      step: this.step.name,
      conditionCount: conditions.length,
    });

    const judgeResult = await this.ctx.structuredCaller.evaluateCondition(
      agentOutput,
      conditions,
      this.structuredCallerJudgeOptions(),
    );
    const matched = conditions.find((condition) => condition.index === judgeResult);
    if (matched) {
      log.debug('AI judge (fallback) matched condition', {
        step: this.step.name,
        ruleIndex: judgeResult,
        condition: matched.text,
      });
      return judgeResult;
    }

    log.debug('AI judge (fallback) did not match any condition', { step: this.step.name });
    return -1;
  }
}
