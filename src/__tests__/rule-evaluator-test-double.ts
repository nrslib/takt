import { vi } from 'vitest';
import type { WorkflowStep } from '../core/models/index.js';
import type {
  RuleEvaluatorContext,
  RuleMatch,
  SemanticSelection,
} from '../core/workflow/evaluation/index.js';

type RuleEvaluationMock = (
  step: WorkflowStep,
  selection: SemanticSelection | undefined,
  context: RuleEvaluatorContext,
) => RuleMatch | undefined;

export const mockRuleEvaluation = vi.fn<RuleEvaluationMock>();

export class MockRuleEvaluator {
  constructor(
    private readonly step: WorkflowStep,
    private readonly context: RuleEvaluatorContext,
  ) {}

  evaluate(selection: SemanticSelection | undefined): RuleMatch | undefined {
    return mockRuleEvaluation(this.step, selection, this.context);
  }
}
