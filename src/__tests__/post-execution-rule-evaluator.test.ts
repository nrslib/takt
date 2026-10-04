import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowState } from '../core/models/types.js';
import type { RuleEvaluatorContext } from '../core/workflow/evaluation/RuleEvaluator.js';
import type { StatusJudgmentPhaseContext } from '../core/workflow/phase-runner.js';
import { RuleDetectionExhaustedError } from '../core/workflow/evaluation/RuleDetectionExhaustedError.js';
import { makeRule, makeStep } from './test-helpers.js';

const {
  mockRuleEvaluation,
  mockRunStatusJudgmentPhase,
} = vi.hoisted(() => ({
  mockRuleEvaluation: vi.fn(),
  mockRunStatusJudgmentPhase: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/workflow/evaluation/index.js')>()),
  RuleEvaluator: class {
    constructor(
      private readonly step: unknown,
      private readonly context: unknown,
    ) {}

    evaluate(selection: unknown): unknown {
      return mockRuleEvaluation(this.step, selection, this.context);
    }
  },
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  runStatusJudgmentPhase: mockRunStatusJudgmentPhase,
}));

import { evaluatePostExecutionRules } from '../core/workflow/engine/post-execution-rule-evaluator.js';

function createState(): WorkflowState {
  return {
    workflowName: 'post-execution-rule-evaluator',
    currentStep: 'review',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
  };
}

describe('evaluatePostExecutionRules', () => {
  const ruleContext: RuleEvaluatorContext = { state: createState() };
  const statusJudgmentContext = {} as StatusJudgmentPhaseContext;
  const getStatusJudgmentContext = vi.fn(() => statusJudgmentContext);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should auto-select one semantic label without resolving status judgment context', async () => {
    const step = makeStep({ rules: [makeRule('approved', 'COMPLETE')] });
    const selection = { label: 'approved', method: 'auto_select' } as const;
    const match = { index: 0, method: 'auto_select' } as const;
    mockRuleEvaluation.mockReturnValue(match);

    await expect(evaluatePostExecutionRules(step, getStatusJudgmentContext, ruleContext)).resolves.toEqual(match);

    expect(getStatusJudgmentContext).not.toHaveBeenCalled();
    expect(mockRunStatusJudgmentPhase).not.toHaveBeenCalled();
    expect(mockRuleEvaluation).toHaveBeenCalledWith(step, selection, ruleContext);
  });

  it('should run status judgment when multiple semantic labels are selectable', async () => {
    const step = makeStep({
      rules: [
        makeRule('approved', 'COMPLETE'),
        makeRule('needs_fix', 'fix'),
      ],
    });
    const selection = { label: 'approved', method: 'structured_output' } as const;
    const match = { index: 0, method: 'structured_output' } as const;
    mockRunStatusJudgmentPhase.mockResolvedValue(selection);
    mockRuleEvaluation.mockReturnValue(match);

    await expect(evaluatePostExecutionRules(step, getStatusJudgmentContext, ruleContext)).resolves.toEqual(match);

    expect(getStatusJudgmentContext).toHaveBeenCalledOnce();
    expect(mockRunStatusJudgmentPhase).toHaveBeenCalledWith(step, statusJudgmentContext);
    expect(mockRuleEvaluation).toHaveBeenCalledWith(step, selection, ruleContext);
  });

  it('should evaluate machine-only rules without invoking status judgment', async () => {
    const step = makeStep({ rules: [makeRule('when(true)', 'COMPLETE')] });
    const match = { index: 0, method: 'auto_select' } as const;
    mockRuleEvaluation.mockReturnValue(match);

    await expect(evaluatePostExecutionRules(step, getStatusJudgmentContext, ruleContext)).resolves.toEqual(match);

    expect(getStatusJudgmentContext).not.toHaveBeenCalled();
    expect(mockRunStatusJudgmentPhase).not.toHaveBeenCalled();
    expect(mockRuleEvaluation).toHaveBeenCalledWith(step, undefined, ruleContext);
  });

  it('should accept a preceding machine rule before starting semantic selection', async () => {
    const machineRule = makeRule('when(true)', 'COMPLETE');
    const semanticRule = makeRule('approved', 'COMPLETE');
    const step = makeStep({ rules: [machineRule, semanticRule] });
    const match = { index: 0, method: 'auto_select' } as const;
    mockRuleEvaluation.mockReturnValue(match);

    await expect(evaluatePostExecutionRules(step, getStatusJudgmentContext, ruleContext)).resolves.toEqual(match);

    expect(getStatusJudgmentContext).not.toHaveBeenCalled();
    expect(mockRunStatusJudgmentPhase).not.toHaveBeenCalled();
    expect(mockRuleEvaluation).toHaveBeenCalledWith(
      { ...step, rules: [machineRule] },
      undefined,
      ruleContext,
    );
  });

  it('should propagate a failed semantic selection without evaluating later rules', async () => {
    const machineRule = makeRule('when(false)', 'COMPLETE');
    const semanticRule = makeRule('approved', 'COMPLETE');
    const alternativeRule = makeRule('needs_fix', 'fix');
    const step = makeStep({ rules: [machineRule, semanticRule, alternativeRule] });
    const selectionError = new Error('invalid semantic selection');
    mockRuleEvaluation.mockImplementationOnce(() => {
      throw new RuleDetectionExhaustedError('No matching rule');
    });
    mockRunStatusJudgmentPhase.mockRejectedValue(selectionError);

    await expect(evaluatePostExecutionRules(step, getStatusJudgmentContext, ruleContext)).rejects.toThrow(selectionError);

    expect(getStatusJudgmentContext).toHaveBeenCalledOnce();
    expect(mockRuleEvaluation).toHaveBeenCalledTimes(1);
    expect(mockRunStatusJudgmentPhase).toHaveBeenCalledWith(step, statusJudgmentContext);
  });

  it('should evaluate all rules once after a successful semantic selection', async () => {
    const machineRule = makeRule('when(false)', 'COMPLETE');
    const semanticRule = makeRule('approved', 'COMPLETE');
    const alternativeRule = makeRule('needs_fix', 'fix');
    const step = makeStep({ rules: [machineRule, semanticRule, alternativeRule] });
    const selection = { label: 'approved', method: 'phase3_tag' } as const;
    const match = { index: 1, method: 'phase3_tag' } as const;
    mockRuleEvaluation
      .mockImplementationOnce(() => {
        throw new RuleDetectionExhaustedError('No matching rule');
      })
      .mockReturnValueOnce(match);
    mockRunStatusJudgmentPhase.mockResolvedValue(selection);

    await expect(evaluatePostExecutionRules(step, getStatusJudgmentContext, ruleContext)).resolves.toEqual(match);

    expect(getStatusJudgmentContext).toHaveBeenCalledOnce();
    expect(mockRuleEvaluation).toHaveBeenNthCalledWith(1, { ...step, rules: [machineRule] }, undefined, ruleContext);
    expect(mockRuleEvaluation).toHaveBeenNthCalledWith(2, step, selection, ruleContext);
  });
});
