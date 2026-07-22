import type { WorkflowStep, WorkflowState, RuleMatchMethod } from '../../models/types.js';
import { type WorkflowRuleCondition, hasFindingsReference } from '../../models/workflow-rule-condition.js';
import { AggregateEvaluator } from './AggregateEvaluator.js';
import { evaluateWhenExpression } from './when-evaluator.js';
import { RuleDetectionExhaustedError } from './RuleDetectionExhaustedError.js';

export interface RuleMatch { index: number; method: RuleMatchMethod; }
export interface SemanticSelection { label: string; method: RuleMatchMethod; }

export interface RuleEvaluatorContext {
  state: WorkflowState;
  interactive?: boolean;
}

export class RuleEvaluator {
  constructor(private readonly step: WorkflowStep, private readonly ctx: RuleEvaluatorContext) {}

  evaluate(selection: SemanticSelection | undefined): RuleMatch | undefined {
    const rules = this.step.rules;
    if (rules === undefined || rules.length === 0) return undefined;
    const conditions = rules.map((rule) => rule.condition);
    if (conditions.some(hasFindingsReference) && this.ctx.state.findings === undefined) {
      throw new Error('Missing workflow findings state');
    }
    for (let index = 0; index < rules.length; index++) {
      const rule = rules[index];
      const condition = conditions[index];
      if (rule === undefined || condition === undefined || (rule.interactiveOnly && this.ctx.interactive !== true)) continue;
      const method = this.evaluateCondition(condition, selection);
      if (method !== undefined) return { index, method };
    }
    throw new RuleDetectionExhaustedError(this.step.name);
  }

  private evaluateCondition(condition: WorkflowRuleCondition, selection: SemanticSelection | undefined): RuleMatchMethod | undefined {
    switch (condition.kind) {
      case 'semantic': return selection?.label === condition.label ? selection.method : undefined;
      case 'when': return evaluateWhenExpression(condition.expression, this.ctx.state) ? 'auto_select' : undefined;
      case 'aggregate': return new AggregateEvaluator(this.step, this.ctx.state).evaluateCondition(condition) ? 'aggregate' : undefined;
      case 'and': {
        const method = this.evaluateCondition(condition.left, selection);
        return method !== undefined && this.evaluateCondition(condition.right, selection) !== undefined ? method : undefined;
      }
    }
  }
}
