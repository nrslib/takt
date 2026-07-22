import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/evaluation/index.js')>();
  const { MockRuleEvaluator } = await import('./rule-evaluator-test-double.js');
  return {
    ...actual,
    RuleEvaluator: MockRuleEvaluator,
  };
});

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: '', method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import { runAgent } from '../agents/runner.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';
import { runReportPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import { RuleDetectionExhaustedError } from '../core/workflow/evaluation/RuleDetectionExhaustedError.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import {
  makeResponse,
  makeStep,
  makeRule,
  buildDefaultWorkflowConfig,
  mockRunAgentSequence,
  mockRuleEvaluationSequence,
  createTestTmpDir,
  applyDefaultMocks,
} from './engine-test-helpers.js';

describe('WorkflowEngine Integration: Error Handling', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('No rule matched', () => {
    it('should abort when mockRuleEvaluation returns undefined', async () => {
      const config = buildDefaultWorkflowConfig();
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Unclear output' }),
      ]);

      mockRuleEvaluationSequence([undefined]);

      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledOnce();
      const reason = abortFn.mock.calls[0]![1] as string;
      expect(reason).toContain('rule_no_match');
    });
  });

  describe('User input runtime requirements', () => {
    it('should abort before running a user-input step when workflow interactive mode is disabled', async () => {
      const config = buildDefaultWorkflowConfig({
        initialStep: 'replan',
        steps: [
          makeStep('replan', {
            requiresUserInput: true,
            rules: [makeRule('done', 'COMPLETE')],
          }),
        ],
      });
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
      expect(abortFn).toHaveBeenCalledOnce();
      const abortState = abortFn.mock.calls[0]?.[0];
      expect(abortState?.status).toBe('aborted');
      expect(abortState?.currentStep).toBe('replan');
      const reason = abortFn.mock.calls[0]?.[1] as string;
      expect(reason).toContain('interactive mode is disabled');
    });

    it('should abort before running a user-input step when no user input handler is configured', async () => {
      const config = buildDefaultWorkflowConfig({
        initialStep: 'replan',
        steps: [
          makeStep('replan', {
            requiresUserInput: true,
            rules: [makeRule('done', 'COMPLETE')],
          }),
        ],
      });
      const engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        interactive: true,
      });

      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
      expect(abortFn).toHaveBeenCalledOnce();
      const abortState = abortFn.mock.calls[0]?.[0];
      expect(abortState?.status).toBe('aborted');
      expect(abortState?.currentStep).toBe('replan');
      const reason = abortFn.mock.calls[0]?.[1] as string;
      expect(reason).toContain('no handler is configured');
    });

    it('should run a user-input step without waiting when interactive requirements are satisfied and no rule asks for input', async () => {
      const config = buildDefaultWorkflowConfig({
        initialStep: 'replan',
        steps: [
          makeStep('replan', {
            requiresUserInput: true,
            rules: [makeRule('done', 'COMPLETE')],
          }),
        ],
      });
      const onUserInput = vi.fn();
      const engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        interactive: true,
        onUserInput,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'replan', status: 'done', content: 'done' }),
      ]);
      mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(vi.mocked(runAgent)).toHaveBeenCalledOnce();
      expect(onUserInput).not.toHaveBeenCalled();
    });

    it('should collect exec replan input, rerun replan, and return to execute', async () => {
      const workerStep = makeStep('worker-1', {
        rules: [makeRule('done', 'COMPLETE')],
      });
      const judgeStep = makeStep('judge-1', {
        rules: [
          makeRule('approved', 'COMPLETE'),
          makeRule('needs_fix', 'COMPLETE'),
          makeRule('needs_replan', 'COMPLETE'),
        ],
      });
      const config = buildDefaultWorkflowConfig({
        initialStep: 'execute',
        steps: [
          makeStep('execute', {
            parallel: [workerStep],
            rules: [
              makeRule('all("done")', 'judge'),
            ],
          }),
          makeStep('judge', {
            parallel: [judgeStep],
            rules: [
              makeRule('all("approved")', 'COMPLETE'),
              makeRule('any("needs_replan")', 'replan'),
            ],
          }),
          makeStep('replan', {
            requiresUserInput: true,
            rules: [
              makeRule('User input needed for clarification', 'replan', {
                requiresUserInput: true,
                interactiveOnly: true,
              }),
              makeRule('New plan ready', 'execute'),
              makeRule('Cannot proceed', 'ABORT'),
            ],
          }),
        ],
      });
      const onUserInput = vi.fn().mockResolvedValueOnce('Refine the implementation plan');
      const engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        interactive: true,
        onUserInput,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'worker-1', content: 'done' }),
        makeResponse({ persona: 'judge-1', content: 'needs_replan' }),
        makeResponse({ persona: 'replan', content: 'User input needed for clarification' }),
        makeResponse({ persona: 'replan', content: 'New plan ready' }),
        makeResponse({ persona: 'worker-1', content: 'done' }),
        makeResponse({ persona: 'judge-1', content: 'approved' }),
      ]);
      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'aggregate' },
        { index: 2, method: 'phase3_tag' },
        { index: 1, method: 'aggregate' },
        { index: 0, method: 'phase3_tag' },
        { index: 1, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'aggregate' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'aggregate' },
      ]);

      const userInputFn = vi.fn();
      engine.on('step:user_input', userInputFn);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(onUserInput).toHaveBeenCalledOnce();
      expect(onUserInput).toHaveBeenCalledWith(expect.objectContaining({
        step: expect.objectContaining({ name: 'replan' }),
        prompt: 'User input needed for clarification',
      }));
      expect(userInputFn).toHaveBeenCalledOnce();
      expect(state.userInputs).toEqual(['Refine the implementation plan']);
      expect(state.stepIterations.get('replan')).toBe(2);
      expect(vi.mocked(runAgent).mock.calls.map((call) => call[0])).toEqual([
        '../personas/worker-1.md',
        '../personas/judge-1.md',
        '../personas/replan.md',
        '../personas/replan.md',
        '../personas/worker-1.md',
        '../personas/judge-1.md',
      ]);
    });

    it('should abort exec replan when requested user input is canceled', async () => {
      const workerStep = makeStep('worker-1', {
        rules: [makeRule('done', 'COMPLETE')],
      });
      const judgeStep = makeStep('judge-1', {
        rules: [
          makeRule('approved', 'COMPLETE'),
          makeRule('needs_replan', 'COMPLETE'),
        ],
      });
      const config = buildDefaultWorkflowConfig({
        initialStep: 'execute',
        steps: [
          makeStep('execute', {
            parallel: [workerStep],
            rules: [
              makeRule('all("done")', 'judge'),
            ],
          }),
          makeStep('judge', {
            parallel: [judgeStep],
            rules: [
              makeRule('all("approved")', 'COMPLETE'),
              makeRule('any("needs_replan")', 'replan'),
            ],
          }),
          makeStep('replan', {
            requiresUserInput: true,
            rules: [
              makeRule('User input needed for clarification', 'replan', {
                requiresUserInput: true,
                interactiveOnly: true,
              }),
              makeRule('New plan ready', 'execute'),
            ],
          }),
        ],
      });
      const onUserInput = vi.fn().mockResolvedValueOnce(null);
      const engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        interactive: true,
        onUserInput,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'worker-1', content: 'done' }),
        makeResponse({ persona: 'judge-1', content: 'needs_replan' }),
        makeResponse({ persona: 'replan', content: 'User input needed for clarification' }),
      ]);
      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'aggregate' },
        { index: 1, method: 'phase3_tag' },
        { index: 1, method: 'aggregate' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(state.currentStep).toBe('replan');
      expect(state.userInputs).toEqual([]);
      expect(onUserInput).toHaveBeenCalledOnce();
      expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(3);
    });
  });

  describe('runAgent throws', () => {
    it('should abort when runAgent throws an error', async () => {
      const config = buildDefaultWorkflowConfig();
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      vi.mocked(runAgent).mockRejectedValueOnce(new Error('API connection failed'));

      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledOnce();
      const reason = abortFn.mock.calls[0]![1] as string;
      expect(reason).toContain('API connection failed');
    });

  });

  describe('Phase 3 failure', () => {
    it('should abort without Phase 1 rule evaluation when status judgment throws', async () => {
      const config = buildDefaultWorkflowConfig({
        initialStep: 'plan',
        steps: [
          makeStep('plan', {
            rules: [
              makeRule('continue', 'COMPLETE'),
              makeRule('retry', 'plan'),
            ],
          }),
        ],
      });
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      vi.mocked(runStatusJudgmentPhase).mockRejectedValueOnce(new Error('Phase 3 failed'));

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: '[STEP:1] continue' }),
      ]);
      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(runStatusJudgmentPhase).toHaveBeenCalledOnce();
      expect(mockRuleEvaluation).not.toHaveBeenCalled();
      expect(state.stepOutputs.get('plan')).toBeUndefined();
    });
  });

  describe('Error status', () => {
    it('should abort immediately and skip report phase when step returns error', async () => {
      const config = buildDefaultWorkflowConfig({
        initialStep: 'plan',
        steps: [
          makeStep('plan', {
            outputContracts: [{ name: '01-plan.md', format: '# Plan' }],
            rules: [makeRule('continue', 'COMPLETE')],
          }),
        ],
      });
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({
          persona: 'plan',
          status: 'error',
          content: 'Partial response',
          error: 'interrupted by signal',
        }),
      ]);

      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledOnce();
      expect(runReportPhase).not.toHaveBeenCalled();
    });

    it('should abort when a step returns an unhandled status and skip report phase', async () => {
      const config = buildDefaultWorkflowConfig({
        initialStep: 'plan',
        steps: [
          makeStep('plan', {
            outputContracts: [{ name: '01-plan.md', format: '# Plan' }],
            rules: [makeRule('continue', 'COMPLETE')],
          }),
        ],
      });
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({
          persona: 'plan',
          status: 'pending' as never,
          content: 'pending response',
        }),
      ]);

      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledOnce();
      const reason = abortFn.mock.calls[0]![1] as string;
      expect(reason).toContain('Unhandled response status: pending');
      expect(runReportPhase).not.toHaveBeenCalled();
    });
  });

  describe('runSingleIteration status routing', () => {
    it('should classify an exhausted semantic selection as rule_no_match', async () => {
      const config = buildDefaultWorkflowConfig({
        initialStep: 'plan',
        steps: [
          makeStep('plan', {
            rules: [makeRule('continue', 'COMPLETE')],
          }),
        ],
      });
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });
      mockRunAgentSequence([makeResponse({ persona: 'plan', content: 'no matching label' })]);
      vi.mocked(mockRuleEvaluation).mockImplementationOnce(() => {
        throw new RuleDetectionExhaustedError('plan');
      });
      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const result = await engine.runSingleIteration();

      expect(result.nextStep).toBe('ABORT');
      expect(result.isComplete).toBe(true);
      expect(engine.getState().status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledWith(expect.anything(), 'rule_no_match', 'rule_no_match');
    });

    it('should abort without rule resolution when a step returns blocked', async () => {
      const config = buildDefaultWorkflowConfig({
        initialStep: 'plan',
        steps: [
          makeStep('plan', {
            rules: [makeRule('continue', 'COMPLETE')],
          }),
        ],
      });
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({
          persona: 'plan',
          status: 'blocked',
          content: 'need input',
        }),
      ]);

      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const result = await engine.runSingleIteration();

      expect(result.nextStep).toBe('ABORT');
      expect(result.isComplete).toBe(true);
      expect(engine.getState().status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledOnce();
    });

    it('should abort without rule resolution when a step returns error', async () => {
      const config = buildDefaultWorkflowConfig({
        initialStep: 'plan',
        steps: [
          makeStep('plan', {
            rules: [makeRule('continue', 'COMPLETE')],
          }),
        ],
      });
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({
          persona: 'plan',
          status: 'error',
          content: 'failed',
          error: 'request failed',
        }),
      ]);

      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const result = await engine.runSingleIteration();

      expect(result.nextStep).toBe('ABORT');
      expect(result.isComplete).toBe(true);
      expect(engine.getState().status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledOnce();
      const reason = abortFn.mock.calls[0]![1] as string;
      expect(reason).toContain('Step "plan" failed: request failed');
    });

    it('should complete when a matched rule returns a logical result', async () => {
      const config = buildDefaultWorkflowConfig({
        initialStep: 'plan',
        steps: [
          makeStep('plan', {
            rules: [
              normalizeRule({ condition: 'retry', return: 'retry_plan' }),
            ],
          }),
        ],
      });
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({
          persona: 'plan',
          content: '[STEP:1] retry',
        }),
      ]);
      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
      ]);

      const result = await engine.runSingleIteration();

      expect(result.nextStep).toBe('COMPLETE');
      expect(result.isComplete).toBe(true);
      expect(result.returnValue).toBe('retry_plan');
      expect(engine.getState().status).toBe('completed');
      expect(result.response.matchedRuleIndex).toBe(0);
    });
  });

  it('should classify an aborted execution as interrupt before rule_no_match', async () => {
    const abortController = new AbortController();
    const config = buildDefaultWorkflowConfig({
      initialStep: 'plan',
      steps: [
        makeStep('plan', {
          rules: [makeRule('continue', 'COMPLETE')],
        }),
      ],
    });
    const engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      abortSignal: abortController.signal,
    });
    mockRunAgentSequence([makeResponse({ persona: 'plan', content: 'no matching label' })]);
    vi.mocked(mockRuleEvaluation).mockImplementationOnce(() => {
      abortController.abort(new Error('cancelled'));
      throw new RuleDetectionExhaustedError('plan');
    });
    const abortFn = vi.fn();
    engine.on('workflow:abort', abortFn);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortFn).toHaveBeenCalledWith(
      expect.anything(),
      'Workflow interrupted by external AbortSignal',
      'interrupt',
    );
  });

  describe('Loop detection', () => {
    it('should abort when loop detected with action: abort', async () => {
      const config = buildDefaultWorkflowConfig({
        maxSteps: 100,
        loopDetection: { maxConsecutiveSameStep: 3, action: 'abort' },
        initialStep: 'loop-step',
        steps: [
          makeStep('loop-step', {
            rules: [makeRule('continue', 'loop-step')],
          }),
        ],
      });

      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      for (let i = 0; i < 5; i++) {
        vi.mocked(runAgent).mockImplementationOnce(async (persona, task, options) => {
          options?.onPromptResolved?.({
            systemPrompt: typeof persona === 'string' ? persona : '',
            userInstruction: task,
          });
          return makeResponse({ content: `iteration ${i}` });
        });
        vi.mocked(mockRuleEvaluation).mockReturnValueOnce(
          { index: 0, method: 'phase3_tag' }
        );
      }

      const abortFn = vi.fn();
      engine.on('workflow:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledOnce();
      const reason = abortFn.mock.calls[0]![1] as string;
      expect(reason).toContain('Loop detected');
      expect(reason).toContain('loop-step');
    });
  });

  describe('Iteration limit', () => {
    it('should abort when max iterations reached without onIterationLimit callback', async () => {
      const config = buildDefaultWorkflowConfig({ maxSteps: 2 });
      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan done' }),
        makeResponse({ persona: 'implement', content: 'Impl done' }),
        makeResponse({ persona: 'ai_review', content: 'OK' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const limitFn = vi.fn();
      const abortFn = vi.fn();
      engine.on('iteration:limit', limitFn);
      engine.on('workflow:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(limitFn).toHaveBeenCalledWith(2, 2);
      expect(abortFn).toHaveBeenCalledOnce();
      const reason = abortFn.mock.calls[0]![1] as string;
      expect(reason).toContain('Max steps');
    });

    it('should extend iterations when onIterationLimit provides additional iterations', async () => {
      const config = buildDefaultWorkflowConfig({ maxSteps: 2 });

      const onIterationLimit = vi.fn().mockResolvedValueOnce(10);

      const engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        onIterationLimit,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan done' }),
        makeResponse({ persona: 'implement', content: 'Impl done' }),
        makeResponse({ persona: 'ai_review', content: 'OK' }),
        makeResponse({ persona: 'arch-review', content: 'OK' }),
        makeResponse({ persona: 'security-review', content: 'OK' }),
        makeResponse({ persona: 'supervise', content: 'All passed' }),
      ]);

      mockRuleEvaluationSequence([
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'phase3_tag' },
        { index: 0, method: 'aggregate' },
        { index: 0, method: 'phase3_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(onIterationLimit).toHaveBeenCalledOnce();
    });
  });
});
