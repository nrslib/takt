import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import type { ProviderLadderConfig, ProviderRoutingConfig } from '../core/models/config-types.js';
import type { WorkflowConfig } from '../core/models/index.js';

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
  runReportPhase: vi.fn(),
  runStatusJudgmentPhase: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import { runAgent } from '../agents/runner.js';
import {
  applyDefaultMocks,
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeResponse,
  makeRule,
  makeStep,
  mockRuleEvaluationSequence,
  mockRunAgentSequence,
} from './engine-test-helpers.js';

const BASE_PROFILE = { provider: 'codex' as const, model: 'runtime-base-model' };
const STRONG_PROFILE = { provider: 'claude' as const, model: 'runtime-strong-model' };

function runtimeDefaultsLadder(): ProviderLadderConfig {
  return {
    defaults: [BASE_PROFILE, STRONG_PROFILE],
  };
}

function runtimeStepTarget(workflowName: string): {
  providerRouting: ProviderRoutingConfig;
  providerLadders: ProviderLadderConfig;
} {
  return {
    providerRouting: {
      workflowName,
      steps: {
        implement: BASE_PROFILE,
      },
    },
    providerLadders: {
      workflowName,
      steps: {
        [`${workflowName}/implement`]: [BASE_PROFILE, STRONG_PROFILE],
      },
    },
  };
}

describe('WorkflowEngine runtime ladder promotion', () => {
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

  it('advances the runtime defaults ladder when the workflow reaches an at threshold', async () => {
    const config: WorkflowConfig = {
      name: 'promotion-runtime-defaults',
      steps: [makeStep('implement', {
        rules: [makeRule('done', 'review')],
        promotion: [{ at: 2 }],
      }), makeStep('review', {
        rules: [
          makeRule('needs_fix', 'implement'),
          makeRule('approved', 'COMPLETE'),
        ],
      })],
      initialStep: 'implement',
      maxSteps: 4,
    };

    mockRunAgentSequence([
      makeResponse({ persona: 'implement', content: 'done' }),
      makeResponse({ persona: 'review', content: 'needs_fix' }),
      makeResponse({ persona: 'implement', content: 'done' }),
      makeResponse({ persona: 'review', content: 'approved' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 1, method: 'phase3_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: BASE_PROFILE.provider,
      providerSource: 'runtime-v1',
      model: BASE_PROFILE.model,
      modelSource: 'runtime-v1',
      providerLadders: runtimeDefaultsLadder(),
    });

    const startFn = vi.fn();
    engine.on('step:start', startFn);
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]).toMatchObject({
      resolvedProvider: BASE_PROFILE.provider,
      resolvedModel: BASE_PROFILE.model,
    });
    expect(vi.mocked(runAgent).mock.calls[2]?.[2]).toMatchObject({
      resolvedProvider: STRONG_PROFILE.provider,
      resolvedModel: STRONG_PROFILE.model,
    });
    expect(startFn.mock.calls.find((call) => call[0]?.name === 'implement' && call[1] === 3)?.[3]).toMatchObject({
      provider: STRONG_PROFILE.provider,
      model: STRONG_PROFILE.model,
      providerSource: 'promotion',
      modelSource: 'promotion',
    });
  });

  it('advances the ladder belonging to a runtime step target and leaves other steps unchanged', async () => {
    const config: WorkflowConfig = {
      name: 'promotion-runtime-step-target',
      steps: [makeStep('implement', {
        rules: [makeRule('done', 'review')],
        promotion: [{ at: 2 }],
      }), makeStep('review', {
        rules: [
          makeRule('needs_fix', 'implement'),
          makeRule('approved', 'COMPLETE'),
        ],
      })],
      initialStep: 'implement',
      maxSteps: 4,
    };
    const runtime = runtimeStepTarget(config.name);

    mockRunAgentSequence([
      makeResponse({ persona: 'implement', content: 'done' }),
      makeResponse({ persona: 'review', content: 'needs_fix' }),
      makeResponse({ persona: 'implement', content: 'done' }),
      makeResponse({ persona: 'review', content: 'approved' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 1, method: 'phase3_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: BASE_PROFILE.provider,
      providerSource: 'runtime-v1',
      model: BASE_PROFILE.model,
      modelSource: 'runtime-v1',
      ...runtime,
    });

    const startFn = vi.fn();
    engine.on('step:start', startFn);
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]).toMatchObject({
      resolvedProvider: BASE_PROFILE.provider,
      resolvedModel: BASE_PROFILE.model,
    });
    expect(vi.mocked(runAgent).mock.calls[1]?.[2]).toMatchObject({
      resolvedProvider: BASE_PROFILE.provider,
      resolvedModel: BASE_PROFILE.model,
    });
    expect(vi.mocked(runAgent).mock.calls[2]?.[2]).toMatchObject({
      resolvedProvider: STRONG_PROFILE.provider,
      resolvedModel: STRONG_PROFILE.model,
    });
    expect(startFn.mock.calls.find((call) => call[0]?.name === 'implement' && call[1] === 3)?.[3]).toMatchObject({
      provider: STRONG_PROFILE.provider,
      model: STRONG_PROFILE.model,
      providerSource: 'promotion',
      modelSource: 'promotion',
    });
  });

  it('matches only the step-local ladder threshold and never evaluates an AI promotion condition', async () => {
    const config: WorkflowConfig = {
      name: 'promotion-runtime-step-threshold',
      steps: [makeStep('plan', {
        rules: [makeRule('done', 'implement')],
      }), makeStep('implement', {
        rules: [makeRule('done', 'COMPLETE')],
        promotion: [{ at: 2 }],
      })],
      initialStep: 'plan',
      maxSteps: 2,
    };
    const runtime = runtimeStepTarget(config.name);
    const structuredCaller = {
      evaluateCondition: vi.fn().mockRejectedValue(new Error('runtime ladder promotion must not use an AI condition')),
    };

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'done' }),
      makeResponse({ persona: 'implement', content: 'done' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      ...runtime,
      structuredCaller: structuredCaller as never,
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(structuredCaller.evaluateCondition).not.toHaveBeenCalled();
    expect(vi.mocked(runAgent).mock.calls[1]?.[2]).toMatchObject({
      resolvedProvider: BASE_PROFILE.provider,
      resolvedModel: BASE_PROFILE.model,
    });
  });

  it('keeps the runtime profile assignment when no governing ladder exists', async () => {
    const config: WorkflowConfig = {
      name: 'promotion-runtime-profile-no-ladder',
      steps: [makeStep('implement', {
        rules: [makeRule('done', 'COMPLETE')],
        promotion: [{ at: 1 }],
      })],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([makeResponse({ persona: 'implement', content: 'done' })]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: BASE_PROFILE.provider,
      providerSource: 'runtime-v1',
      model: BASE_PROFILE.model,
      modelSource: 'runtime-v1',
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]).toMatchObject({
      resolvedProvider: BASE_PROFILE.provider,
      resolvedModel: BASE_PROFILE.model,
    });
  });
});
