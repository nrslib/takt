import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import type { WorkflowConfig, WorkflowStep, StepProviderOptions } from '../core/models/index.js';
import type { StructuredCaller } from '../agents/structured-caller.js';
import type { ProviderType } from '../shared/types/provider.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn(),
  runReportPhase: vi.fn(),
  runStatusJudgmentPhase: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import { runAgent } from '../agents/runner.js';
import { needsStatusJudgmentPhase, runReportPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import {
  applyDefaultMocks,
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeResponse,
  makeRule,
  makeStep,
  mockDetectMatchedRuleSequence,
  mockRunAgentSequence,
} from './engine-test-helpers.js';

type PromotionEntry = {
  at?: number;
  condition?: string;
  aiConditionText?: string;
  provider?: ProviderType;
  providerSpecified?: boolean;
  model?: string;
  providerOptions?: StepProviderOptions;
};

function withPromotion(step: WorkflowStep, promotion: PromotionEntry[]): WorkflowStep {
  return {
    ...step,
    promotion,
  } as WorkflowStep & { promotion: PromotionEntry[] };
}

function makeStructuredCaller(evaluateCondition: ReturnType<typeof vi.fn>): StructuredCaller {
  return {
    evaluateCondition,
  } as unknown as StructuredCaller;
}

describe('WorkflowEngine promotion', () => {
  let tmpDir: string;
  let engine: WorkflowEngine | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (engine) {
      cleanupWorkflowEngine(engine);
      engine = undefined;
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('applies at-based promotion only to the matching step execution and forwards provider info to runAgent', async () => {
    const evaluateCondition = vi.fn().mockRejectedValue(new Error('AI judge should not run'));
    const implement = withPromotion(makeStep('implement', {
      provider: 'codex',
      model: 'gpt-5.4',
      providerOptions: {
        codex: {
          networkAccess: false,
          reasoningEffort: 'medium',
        },
      },
      rules: [makeRule('done', 'review')],
    }), [
      {
        at: 2,
        provider: 'claude',
        model: 'opus',
        providerOptions: {
          codex: {
            networkAccess: true,
          },
          claude: {
            effort: 'high',
          },
        },
      },
    ]);
    const review = makeStep('review', {
      rules: [
        makeRule('needs_fix', 'implement'),
        makeRule('approved', 'COMPLETE'),
      ],
    });
    const config: WorkflowConfig = {
      name: 'promotion-at-engine',
      steps: [implement, review],
      initialStep: 'implement',
      maxSteps: 4,
    };

    mockRunAgentSequence([
      makeResponse({ persona: 'implement', content: 'done' }),
      makeResponse({ persona: 'review', content: 'needs_fix' }),
      makeResponse({ persona: 'implement', content: 'done' }),
      makeResponse({ persona: 'review', content: 'approved' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 1, method: 'phase1_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'codex',
      model: 'engine-model',
      structuredCaller: makeStructuredCaller(evaluateCondition),
    });
    const startFn = vi.fn();
    engine.on('step:start', startFn);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(evaluateCondition).not.toHaveBeenCalled();

    const firstImplementOptions = vi.mocked(runAgent).mock.calls[0]?.[2];
    const secondImplementOptions = vi.mocked(runAgent).mock.calls[2]?.[2];
    const reviewOptions = vi.mocked(runAgent).mock.calls[1]?.[2];

    expect(firstImplementOptions).toMatchObject({
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5.4',
    });
    expect(secondImplementOptions).toMatchObject({
      resolvedProvider: 'claude',
      resolvedModel: 'opus',
      providerOptions: {
        codex: {
          networkAccess: true,
          reasoningEffort: 'medium',
        },
        claude: {
          effort: 'high',
        },
      },
    });
    expect(reviewOptions).toMatchObject({
      resolvedProvider: 'codex',
      resolvedModel: 'engine-model',
    });

    const secondImplementStart = startFn.mock.calls.find((call) => call[0]?.name === 'implement' && call[1] === 3);
    expect(secondImplementStart?.[3]).toMatchObject({
      provider: 'claude',
      model: 'opus',
      providerSource: 'promotion',
      modelSource: 'promotion',
      providerOptionsSources: {
        'codex.networkAccess': 'promotion',
        'codex.reasoningEffort': 'step',
        'claude.effort': 'promotion',
      },
    });
  });

  it('evaluates condition-based promotion with the previous step output before running the promoted step', async () => {
    const evaluateCondition = vi.fn().mockImplementation(async (
      _content: string,
      conditions: Array<{ index: number; text: string }>,
    ) => conditions[0]?.index ?? -1);
    const plan = makeStep('plan', {
      rules: [makeRule('done', 'implement')],
    });
    const implement = withPromotion(makeStep('implement', {
      provider: 'codex',
      model: 'gpt-5.4',
      rules: [makeRule('done', 'COMPLETE')],
    }), [
      {
        condition: 'ai("plan output says escalation is required")',
        aiConditionText: 'plan output says escalation is required',
        provider: 'claude',
        model: 'opus',
      },
    ]);
    const config: WorkflowConfig = {
      name: 'promotion-condition-engine',
      steps: [plan, implement],
      initialStep: 'plan',
      maxSteps: 2,
    };

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'plan output with escalation' }),
      makeResponse({ persona: 'implement', content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'codex',
      model: 'engine-model',
      structuredCaller: makeStructuredCaller(evaluateCondition),
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(evaluateCondition).toHaveBeenCalledWith(
      'plan output with escalation',
      [expect.objectContaining({ text: 'plan output says escalation is required' })],
      expect.objectContaining({
        cwd: tmpDir,
        provider: 'codex',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.4',
      }),
    );
    expect(vi.mocked(runAgent).mock.calls[1]?.[2]).toMatchObject({
      resolvedProvider: 'claude',
      resolvedModel: 'opus',
    });
  });

  it('does not apply at-based promotion from workflow iteration before the step reaches its own threshold', async () => {
    const evaluateCondition = vi.fn().mockRejectedValue(new Error('AI judge should not run'));
    const plan = makeStep('plan', {
      rules: [makeRule('done', 'implement')],
    });
    const implement = withPromotion(makeStep('implement', {
      provider: 'codex',
      model: 'gpt-5.4',
      rules: [makeRule('done', 'COMPLETE')],
    }), [
      {
        at: 2,
        provider: 'claude',
        model: 'opus',
      },
    ]);
    const config: WorkflowConfig = {
      name: 'promotion-step-iteration-engine',
      steps: [plan, implement],
      initialStep: 'plan',
      maxSteps: 2,
    };

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'done' }),
      makeResponse({ persona: 'implement', content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'codex',
      model: 'engine-model',
      structuredCaller: makeStructuredCaller(evaluateCondition),
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(evaluateCondition).not.toHaveBeenCalled();
    expect(vi.mocked(runAgent).mock.calls[1]?.[2]).toMatchObject({
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5.4',
    });
  });

  it('resets the effective model when promotion specifies a provider without a model', async () => {
    const implement = withPromotion(makeStep('implement', {
      provider: 'codex',
      model: 'gpt-5.4',
      rules: [makeRule('done', 'COMPLETE')],
    }), [
      {
        at: 1,
        provider: 'claude',
        providerSpecified: true,
      },
    ]);
    const config: WorkflowConfig = {
      name: 'promotion-provider-only-engine',
      steps: [implement],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: 'implement', content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'codex',
      model: 'engine-model',
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]?.resolvedProvider).toBe('claude');
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]?.resolvedModel).toBeUndefined();
  });

  it('forwards promoted provider info to report and status judgment phases', async () => {
    const implement = withPromotion(makeStep('implement', {
      provider: 'codex',
      model: 'gpt-5.4',
      providerOptions: {
        codex: {
          reasoningEffort: 'medium',
        },
      },
      outputContracts: [{ name: 'implement.md', format: 'report', useJudge: true }],
      rules: [makeRule('done', 'COMPLETE')],
    }), [
      {
        at: 1,
        provider: 'claude',
        model: 'opus',
        providerOptions: {
          claude: {
            effort: 'high',
          },
        },
      },
    ]);
    const config: WorkflowConfig = {
      name: 'promotion-phases-engine',
      steps: [implement],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: 'implement', content: 'done', sessionId: 'session-implement' }),
    ]);
    vi.mocked(runReportPhase).mockImplementationOnce(async (step, _iteration, ctx) => {
      expect(ctx.resolveStepProviderModel?.(step)).toMatchObject({
        provider: 'claude',
        model: 'opus',
        providerSource: 'promotion',
        modelSource: 'promotion',
        providerOptions: {
          codex: {
            reasoningEffort: 'medium',
          },
          claude: {
            effort: 'high',
          },
        },
      });
      expect(ctx.buildResumeOptions(step, 'session-implement', { maxTurns: 3 })).toMatchObject({
        resolvedProvider: 'claude',
        resolvedModel: 'opus',
        providerOptions: {
          codex: {
            reasoningEffort: 'medium',
          },
          claude: {
            effort: 'high',
          },
        },
      });
      expect(ctx.buildNewSessionReportOptions(step, { allowedTools: ['Write'], maxTurns: 3 })).toMatchObject({
        resolvedProvider: 'claude',
        resolvedModel: 'opus',
      });
      return undefined;
    });
    vi.mocked(needsStatusJudgmentPhase).mockReturnValue(true);
    vi.mocked(runStatusJudgmentPhase).mockImplementationOnce(async (step, ctx) => {
      expect(ctx.resolveStepProviderModel?.(step)).toMatchObject({
        provider: 'claude',
        model: 'opus',
        providerOptionsSources: {
          'codex.reasoningEffort': 'step',
          'claude.effort': 'promotion',
        },
      });
      return { tag: 'done', ruleIndex: 0, method: 'phase3_tag' };
    });

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'codex',
      model: 'engine-model',
      structuredCaller: makeStructuredCaller(vi.fn()),
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(runReportPhase).toHaveBeenCalledOnce();
    expect(runStatusJudgmentPhase).toHaveBeenCalledOnce();
  });

  it('applies at-based promotion in runSingleIteration without AI evaluation', async () => {
    const evaluateCondition = vi.fn().mockRejectedValue(new Error('AI judge should not run'));
    const implement = withPromotion(makeStep('implement', {
      provider: 'codex',
      model: 'gpt-5.4',
      rules: [makeRule('done', 'COMPLETE')],
    }), [
      {
        at: 1,
        provider: 'claude',
        model: 'opus',
      },
    ]);
    const config: WorkflowConfig = {
      name: 'promotion-single-iteration-engine',
      steps: [implement],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: 'implement', content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'codex',
      model: 'engine-model',
      structuredCaller: makeStructuredCaller(evaluateCondition),
    });

    const result = await engine.runSingleIteration();

    expect(result.isComplete).toBe(true);
    expect(evaluateCondition).not.toHaveBeenCalled();
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]).toMatchObject({
      resolvedProvider: 'claude',
      resolvedModel: 'opus',
    });
  });

  it('does not apply at-based promotion in runSingleIteration from workflow iteration alone', async () => {
    const evaluateCondition = vi.fn().mockRejectedValue(new Error('AI judge should not run'));
    const plan = makeStep('plan', {
      rules: [makeRule('done', 'implement')],
    });
    const implement = withPromotion(makeStep('implement', {
      provider: 'codex',
      model: 'gpt-5.4',
      rules: [makeRule('done', 'COMPLETE')],
    }), [
      {
        at: 2,
        provider: 'claude',
        model: 'opus',
      },
    ]);
    const config: WorkflowConfig = {
      name: 'promotion-single-step-iteration-engine',
      steps: [plan, implement],
      initialStep: 'plan',
      maxSteps: 2,
    };

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'done' }),
      makeResponse({ persona: 'implement', content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'codex',
      model: 'engine-model',
      structuredCaller: makeStructuredCaller(evaluateCondition),
    });

    const first = await engine.runSingleIteration();
    const second = await engine.runSingleIteration();

    expect(first).toMatchObject({ nextStep: 'implement', isComplete: false });
    expect(second.isComplete).toBe(true);
    expect(evaluateCondition).not.toHaveBeenCalled();
    expect(vi.mocked(runAgent).mock.calls[1]?.[2]).toMatchObject({
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5.4',
    });
  });

  it('promotes provider options without changing the base provider or model', async () => {
    const implement = withPromotion(makeStep('implement', {
      provider: 'codex',
      model: 'gpt-5.4',
      rules: [makeRule('done', 'COMPLETE')],
    }), [
      {
        at: 1,
        providerOptions: {
          codex: {
            reasoningEffort: 'high',
          },
        },
      },
    ]);
    const config: WorkflowConfig = {
      name: 'promotion-provider-options-only-engine',
      steps: [implement],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: 'implement', content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'codex',
      model: 'engine-model',
    });
    const startFn = vi.fn();
    engine.on('step:start', startFn);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]).toMatchObject({
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5.4',
      providerOptions: {
        codex: {
          reasoningEffort: 'high',
        },
      },
    });
    expect(startFn.mock.calls[0]?.[3]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.4',
      providerOptionsSources: {
        'codex.reasoningEffort': 'promotion',
      },
    });
  });

  it('keeps env and CLI provider option leaves ahead of promotion options', async () => {
    const implement = withPromotion(makeStep('implement', {
      provider: 'codex',
      model: 'gpt-5.4',
      rules: [makeRule('done', 'COMPLETE')],
    }), [
      {
        at: 1,
        providerOptions: {
          codex: {
            networkAccess: true,
            reasoningEffort: 'high',
          },
          claude: {
            effort: 'high',
            sandbox: {
              excludedCommands: [],
            },
          },
        },
      },
    ]);
    const config: WorkflowConfig = {
      name: 'promotion-provider-options-trust-boundary-engine',
      steps: [implement],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: 'implement', content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'codex',
      model: 'engine-model',
      providerOptionsSource: 'project',
      providerOptionsOriginResolver: (path: string) => {
        if (path === 'codex.networkAccess') return 'env';
        if (path === 'claude.sandbox.excludedCommands') return 'cli';
        return 'local';
      },
      providerOptions: {
        codex: {
          networkAccess: false,
        },
        claude: {
          sandbox: {
            excludedCommands: ['git push'],
          },
        },
      },
    });
    const startFn = vi.fn();
    engine.on('step:start', startFn);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]?.providerOptions).toEqual({
      codex: {
        networkAccess: false,
        reasoningEffort: 'high',
      },
      claude: {
        effort: 'high',
        sandbox: {
          excludedCommands: ['git push'],
        },
      },
    });
    expect(startFn.mock.calls[0]?.[3]).toMatchObject({
      providerOptionsSources: {
        'codex.networkAccess': 'env',
        'codex.reasoningEffort': 'promotion',
        'claude.effort': 'promotion',
        'claude.sandbox.excludedCommands': 'cli',
      },
    });
  });
});
