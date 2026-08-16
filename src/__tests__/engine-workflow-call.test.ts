import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';

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

vi.mock('../core/workflow/phase-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/workflow/phase-runner.js')>()),
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
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';
import { WorkflowCallRunner } from '../core/workflow/engine/WorkflowCallRunner.js';
import {
  resolveWorkflowCallChildProviderModel,
} from '../core/workflow/workflow-call-provider-context.js';
import {
  applyDefaultMocks,
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeRule,
  makeResponse,
  mockRuleEvaluationSequence,
  mockRunAgentSequence,
} from './engine-test-helpers.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';
import type {
  AutoRoutingConfig,
  WorkflowConfig,
} from '../core/models/index.js';
import { initAnalyticsWriter } from '../features/analytics/index.js';
import { resetAnalyticsWriter } from '../features/analytics/writer.js';
import { AnalyticsEmitter } from '../features/tasks/execute/analyticsEmitter.js';
import type { RoutingDecisionEvent } from '../features/analytics/index.js';
import type { WorkflowCallResolver } from '../core/workflow/types.js';

import {
  createOwnedResumePoint,
  createParentWorkflow,
  createWorkflowCallAutoRoutingConfig,
  createWorkflowCallOptions,
  createWorkflowCallProgressDeps,
  mockPersonaResponses,
  writeWorkflow,
} from './helpers/engine-workflow-call-shared.js';

function createQualifiedChildAutoRouting(): AutoRoutingConfig {
  const autoRouting = createWorkflowCallAutoRoutingConfig();
  return {
    ...autoRouting,
    candidatePools: {
      ...autoRouting.candidatePools,
      'child-special': { candidates: ['coding'], fallback: 'coding' },
    },
    poolRules: { steps: { 'takt/coding/review': 'child-special' } },
  };
}

describe('WorkflowEngine workflow_call integration', () => {
  let tmpDir: string;
  let cleanupDirs: string[];
  let engine: WorkflowEngine | null = null;
  const originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
    execFileSync('git', ['init', '--quiet'], { cwd: tmpDir });
    execFileSync('git', [
      '-c', 'user.email=test@example.com',
      '-c', 'user.name=Test',
      'commit', '--quiet', '--allow-empty', '-m', 'baseline',
    ], { cwd: tmpDir });
    cleanupDirs = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalTaktConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    }
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    resetAnalyticsWriter();
    if (engine) {
      cleanupWorkflowEngine(engine);
      engine = null;
    }
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('未到達の workflow_call は engine 構築時にも実行時にも解決しない', async () => {
    const onEffectiveAutoRoutingReached = vi.fn();
    const config = createParentWorkflow(tmpDir, {
      name: 'parent-with-unreachable-child',
      initial_step: 'finish',
      max_steps: 2,
      steps: [
        {
          name: 'finish',
          persona: 'finisher',
          instruction: 'Finish without delegation',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
        {
          name: 'unreachable-child',
          kind: 'workflow_call',
          call: 'child-that-must-not-load',
          rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
        },
      ],
    });
    const workflowCallResolver = vi.fn(() => {
      throw new Error('unreachable resolver invoked');
    });

    engine = new WorkflowEngine(config, tmpDir, 'Finish directly', createWorkflowCallOptions(tmpDir, {
      workflowCallResolver,
      autoStrategyOverride: 'performance',
      onEffectiveAutoRoutingReached,
    }));
    expect(workflowCallResolver).not.toHaveBeenCalled();
    mockPersonaResponses({ finisher: 'done' });
    vi.mocked(mockRuleEvaluation).mockReturnValue({ index: 0, method: 'phase3_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(workflowCallResolver).not.toHaveBeenCalled();
    expect(onEffectiveAutoRoutingReached).not.toHaveBeenCalled();
  });

  it('workflow-wide rules are inherited additively by a workflow_call child', async () => {
    writeWorkflow(tmpDir, 'rules/parent-rule.md', 'PARENT_WORKFLOW_RULE');
    writeWorkflow(tmpDir, 'rules/child-rule.md', 'CHILD_WORKFLOW_RULE');
    writeWorkflow(tmpDir, 'child.yaml', `name: child
subworkflow:
  callable: true
  returns: [ok]
initial_step: review
max_steps: 3
all_steps:
  rules:
    - ref: child-rule
      position: before_instruction
steps:
  - name: review
    persona: reviewer
    instruction: Review child work
    rules:
      - condition: done
        return: ok
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 3,
      all_steps: { rules: ['parent-rule'] },
      steps: [{
        name: 'delegate',
        kind: 'workflow_call',
        call: 'child',
        rules: [{ condition: 'ok', next: 'COMPLETE' }],
      }],
    });
    mockPersonaResponses({ reviewer: 'done' });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    engine = new WorkflowEngine(
      config,
      tmpDir,
      'test task',
      createWorkflowCallOptions(tmpDir),
    );
    const state = await engine.run();

    expect(state.status).toBe('completed');
    const childPrompt = vi.mocked(runAgent).mock.calls[0]?.[1];
    expect(childPrompt).toEqual(expect.any(String));
    expect(childPrompt).toContain('PARENT_WORKFLOW_RULE');
    expect(childPrompt).toContain('CHILD_WORKFLOW_RULE');
    expect(childPrompt!.indexOf('PARENT_WORKFLOW_RULE')).toBeLessThan(
      childPrompt!.indexOf('CHILD_WORKFLOW_RULE'),
    );
    expect(childPrompt!.indexOf('CHILD_WORKFLOW_RULE')).toBeLessThan(
      childPrompt!.indexOf('Review child work'),
    );
    expect(childPrompt!.match(/all steps in this workflow/gi)).toHaveLength(1);
  });

  it('strategy override がない場合は到達した child 内の未到達 workflow_call を解決しない', async () => {
    const config = createParentWorkflow(tmpDir, {
      name: 'parent-with-child-that-finishes-directly',
      initial_step: 'call-child',
      max_steps: 3,
      steps: [{
        name: 'call-child',
        kind: 'workflow_call',
        call: 'child',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    });
    const childConfig: WorkflowConfig = {
      name: 'child',
      subworkflow: { callable: true },
      initialStep: 'finish-child',
      steps: [
        {
          name: 'finish-child',
          persona: 'child-finisher',
          instruction: 'Finish child without delegation',
          rules: [makeRule('done', 'COMPLETE')],
        },
        {
          name: 'unreachable-grandchild',
          kind: 'workflow_call',
          call: 'grandchild-that-must-not-load',
          rules: [makeRule('COMPLETE', 'COMPLETE')],
        },
      ],
    };
    const workflowCallResolver = vi.fn((input: Parameters<WorkflowCallResolver>[0]) => {
      if (input.step.call === 'child') {
        return childConfig;
      }
      throw new Error('unreachable grandchild resolver invoked');
    });

    engine = new WorkflowEngine(config, tmpDir, 'Run child directly', createWorkflowCallOptions(tmpDir, {
      workflowCallResolver,
    }));
    mockPersonaResponses({ 'child-finisher': 'done' });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(workflowCallResolver).toHaveBeenCalledOnce();
    expect(workflowCallResolver.mock.calls[0]?.[0].step.call).toBe('child');
  });

  it('到達した workflow_call は実行時に解決し resolver 例外を伝播する', async () => {
    const config = createParentWorkflow(tmpDir, {
      name: 'parent-with-broken-child',
      initial_step: 'call-child',
      max_steps: 1,
      steps: [{
        name: 'call-child',
        kind: 'workflow_call',
        call: 'missing-child',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    });
    const workflowCallResolver = vi.fn(() => {
      throw new Error('resolver boom');
    });
    const workflowAborted = vi.fn();

    engine = new WorkflowEngine(config, tmpDir, 'Resolve child at runtime', createWorkflowCallOptions(tmpDir, {
      workflowCallResolver,
    }));
    engine.on('workflow:abort', workflowAborted);
    expect(workflowCallResolver).not.toHaveBeenCalled();

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBe(0);
    expect(state.stepIterations.get('call-child')).toBe(1);
    expect(workflowCallResolver).toHaveBeenCalledOnce();
    expect(workflowAborted.mock.calls.map(([, reason]) => reason)).toEqual([
      expect.stringContaining('resolver boom'),
    ]);
  });

  it('workflow_call child inherits the already-resolved runtime provider context', () => {
    const parentContext = {
      provider: 'mock' as const,
      providerSource: 'runtime-v1' as const,
      model: 'weak-model',
      modelSource: 'runtime-v1' as const,
      providerPermissionMode: 'full' as const,
    };
    expect(resolveWorkflowCallChildProviderModel(parentContext)).toEqual({
      provider: 'mock',
      providerSource: 'runtime-v1',
      model: 'weak-model',
      modelSource: 'runtime-v1',
      permissionMode: 'full',
    });
  });

  it('子 workflow の最終出力を親 step の previous_response に引き継ぐ', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'final_review',
            },
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
        {
          name: 'final_review',
          persona: 'supervisor',
          instruction: 'Review child output:\n{previous_response}',
          rules: [
            {
              condition: 'approved',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    mockPersonaResponses({
      reviewer: 'Child review complete',
      supervisor: 'approved',
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'Implement workflow composition', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const finalPrompt = vi.mocked(runAgent).mock.calls[1]?.[1];

    expect(state.status).toBe('completed');
    expect(finalPrompt).toContain('Child review complete');
  });

  it('子 workflow の step:rate_limited イベントを親 engine に中継する', async () => {
    writeWorkflow(tmpDir, 'child.yaml', `name: child
subworkflow:
  callable: true
initial_step: limited
steps:
  - name: limited
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 3,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'child',
          rules: [
            {
              condition: 'ABORT',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });
    engine = new WorkflowEngine(config, tmpDir, 'Relay rate limit', createWorkflowCallOptions(tmpDir));
    const rateLimited = makeResponse({
      persona: 'reviewer',
      status: 'rate_limited',
      content: '',
      error: 'Rate limit exceeded. Please try again later.',
      errorKind: 'rate_limit',
      rateLimitInfo: {
        provider: 'mock',
        detectedAt: new Date('2026-05-13T03:00:00.000Z'),
        source: 'sdk_error',
      },
    } as Partial<ReturnType<typeof makeResponse>>);
    mockRunAgentSequence([rateLimited]);
    const onRateLimited = vi.fn();
    engine.on('step:rate_limited', onRateLimited);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(onRateLimited).toHaveBeenCalledOnce();
    expect(onRateLimited.mock.calls[0]?.[0]).toMatchObject({ name: 'limited' });
    expect(onRateLimited.mock.calls[0]?.[1]).toMatchObject({ status: 'rate_limited' });
  });

  it('workflow_call 子 workflow は config 由来の親 fallback を継承する', async () => {
    writeWorkflow(tmpDir, 'child.yaml', `name: child
subworkflow:
  callable: true
initial_step: limited
steps:
  - name: limited
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 3,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'child',
          rules: [
            {
              condition: 'ABORT',
              next: 'COMPLETE',
            },
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });
    engine = new WorkflowEngine(config, tmpDir, 'Child inherits config fallback', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'claude-sonnet',
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
    }));
    mockRunAgentSequence([
      makeResponse({
        persona: 'reviewer',
        status: 'rate_limited',
        content: '',
        error: 'Rate limit exceeded. Please try again later.',
        errorKind: 'rate_limit',
        rateLimitInfo: {
          provider: 'claude',
          detectedAt: new Date('2026-05-13T03:00:00.000Z'),
          source: 'sdk_error',
        },
      } as Partial<ReturnType<typeof makeResponse>>),
      makeResponse({ persona: 'reviewer', content: 'done' }),
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]?.resolvedProvider).toBe('claude');
    expect(vi.mocked(runAgent).mock.calls[1]?.[2]?.resolvedProvider).toBe('codex');
  });

  it('workflow_call 子 workflow の rate_limit_fallback はロード時に拒否する', async () => {
    writeWorkflow(tmpDir, 'child.yaml', `name: child
subworkflow:
  callable: true
rate_limit_fallback: {}
initial_step: limited
steps:
  - name: limited
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 3,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'child',
          rules: [
            {
              condition: 'ABORT',
              next: 'COMPLETE',
            },
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });
    engine = new WorkflowEngine(config, tmpDir, 'Child disables fallback', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'claude-sonnet',
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
    }));
    mockRunAgentSequence([
      makeResponse({
        persona: 'reviewer',
        status: 'rate_limited',
        content: '',
        error: 'Rate limit exceeded. Please try again later.',
        errorKind: 'rate_limit',
        rateLimitInfo: {
          provider: 'claude',
          detectedAt: new Date('2026-05-13T03:00:00.000Z'),
          source: 'sdk_error',
        },
      } as Partial<ReturnType<typeof makeResponse>>),
      makeResponse({ persona: 'reviewer', content: 'done' }),
    ]);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('親 task を child workflow の agent prompt へデフォルト伝搬する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Child task context:\\n{task}"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    const parentTask = 'Propagate parent task into child workflow';
    engine = new WorkflowEngine(config, tmpDir, parentTask, createWorkflowCallOptions(tmpDir));

    await engine.run();

    const childPrompt = vi.mocked(runAgent).mock.calls[0]?.[1];

    expect(childPrompt).toContain(parentTask);
  });

  it('親 workflow は child workflow の return 値で分岐できる', async () => {
    writeWorkflow(tmpDir, 'shared/review-loop.yaml', `name: shared/review-loop
subworkflow:
  callable: true
  returns: [ok, retry_plan]
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: retry
        return: retry_plan
      - condition: done
        return: ok
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'shared/review-loop',
          rules: [
            {
              condition: 'retry_plan',
              next: 'plan',
            },
            {
              condition: 'ok',
              next: 'COMPLETE',
            },
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
        {
          name: 'plan',
          persona: 'planner',
          instruction: 'Replan from child output:\n{previous_response}',
          rules: [
            {
              condition: 'done',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    mockPersonaResponses({
      reviewer: 'Child requested replan',
      planner: 'done',
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'Branch on child return', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const planPrompt = vi.mocked(runAgent).mock.calls[1]?.[1];

    expect(state.status).toBe('completed');
    expect(planPrompt).toContain('Child requested replan');
  });

  it('engine 実行時に予約語 callable return を持つ child workflow を reject する', async () => {
    writeWorkflow(tmpDir, 'shared/review-loop.yaml', `name: shared/review-loop
subworkflow:
  callable: true
  returns: [ABORT]
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'shared/review-loop',
          rules: [
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
      ],
    });

    const workflowAborted = vi.fn();
    engine = new WorkflowEngine(
      config,
      tmpDir,
      'Reject reserved child return names',
      createWorkflowCallOptions(tmpDir),
    );
    engine.on('workflow:abort', workflowAborted);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(workflowAborted.mock.calls.map(([, reason]) => reason)).toEqual([
      expect.stringMatching(/subworkflow\.returns must not include reserved result/),
    ]);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('workflow_call は親で解決済みの runtime provider context を子へ伝搬する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'Inherit runtime child provider', createWorkflowCallOptions(tmpDir, {
      provider: 'codex',
      model: 'gpt-5-codex',
      providerSource: 'runtime-v1',
      providerOptionsProviderSource: 'runtime-v1',
      providerPermissionMode: 'full',
      providerOptions: {
        codex: { networkAccess: true },
      },
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('codex');
    expect(options?.resolvedModel).toBe('gpt-5-codex');
    expect(options?.permissionMode).toBe('full');
    expect(options?.providerOptions).toEqual({
      codex: {
        networkAccess: true,
      },
    });
  });

  it('workflow_call は子 workflow の runtime persona routing を維持する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [{
        name: 'delegate',
        kind: 'workflow_call',
        call: 'takt/coding',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({ persona: 'reviewer', content: 'done' }));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);
    const startedProviderInfo: Array<Record<string, unknown>> = [];
    engine = new WorkflowEngine(config, tmpDir, 'Keep runtime persona routing', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'target-model',
      providerSource: 'runtime-v1',
      providerOptionsProviderSource: 'runtime-v1',
      providerOptions: {
        claude: { allowedTools: ['Read'] },
      },
    }));
    engine.on('step:start', (step, _iteration, _instruction, providerInfo) => {
      if (step.name === 'review') {
        startedProviderInfo.push(providerInfo as unknown as Record<string, unknown>);
      }
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.resolvedProvider).toBe('claude');
    expect(options?.resolvedModel).toBe('target-model');
    expect(options?.providerOptions).toEqual({ claude: { allowedTools: ['Read'] } });
    expect(startedProviderInfo[0]?.providerOptions).toEqual({ claude: { allowedTools: ['Read'] } });
    expect(startedProviderInfo[0]?.providerOptionsSources).toEqual({
      'claude.allowedTools': 'default',
    });
  });

  it('workflow_call は親 runtime の provider と model を継承する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'Inherit child provider and model', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'parent-model',
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('claude');
    expect(options?.resolvedModel).toBe('parent-model');
  });

  it('workflow_call は child persona routing を継承する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Inherit child persona routing', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'parent-model',
      personaProviders: {
        reviewer: {
          provider: 'opencode',
          model: 'opencode/reviewer-model',
        },
      },
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('opencode');
    expect(options?.resolvedModel).toBe('opencode/reviewer-model');
  });

  it('workflow_call は child step routing を継承する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Inherit child step routing', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'parent-model',
      providerRouting: {
        steps: {
          review: {
            provider: 'opencode',
            model: 'opencode/stale-review-model',
            providerOptions: {
              codex: { reasoningEffort: 'high' },
            },
          },
        },
      },
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('opencode');
    expect(options?.resolvedModel).toBe('opencode/stale-review-model');
    expect(options?.providerOptions).toMatchObject({
      codex: { reasoningEffort: 'high' },
    });
  });

  it('workflow_call は child persona の runtime provider options を維持する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Keep child persona provider options', createWorkflowCallOptions(tmpDir, {
      provider: 'opencode',
      model: 'parent-model',
      providerOptions: {
        codex: { networkAccess: false },
      },
      personaProviders: {
        reviewer: {
          provider: 'opencode',
          model: 'opencode/reviewer-model',
          providerOptions: {
            codex: { reasoningEffort: 'high' },
          },
        },
      },
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('opencode');
    expect(options?.resolvedModel).toBe('opencode/reviewer-model');
    expect(options?.providerOptions).toEqual({
      codex: {
        networkAccess: false,
        reasoningEffort: 'high',
      },
    });
  });

  it('workflow_call は child persona の provider と model を継承する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Inherit child model with persona provider fallback', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'parent-model',
      personaProviders: {
        reviewer: {
          provider: 'opencode',
          model: 'opencode/reviewer-model',
          permissionMode: 'readonly',
          providerOptions: {
            opencode: { networkAccess: false },
          },
        },
      },
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('opencode');
    expect(options?.resolvedModel).toBe('opencode/reviewer-model');
    expect(options?.permissionMode).toBe('readonly');
    expect(options?.providerOptions).toEqual({
      opencode: { networkAccess: false },
    });
  });

  it.each([
    { name: 'provider only', overrides: { provider: 'opencode' } },
    { name: 'provider with model', overrides: { provider: 'opencode', model: 'big-pickle' } },
    { name: 'provider options only', overrides: { provider_options: { opencode: { network_access: true } } } },
  ])('workflow_call removed execution settings are rejected at load time: $name', ({ overrides }) => {
    expect(() => createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 1,
      steps: [{
        name: 'delegate',
        kind: 'workflow_call',
        call: 'child',
        overrides,
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    })).toThrow(/configure provider\/model\/options in runtime\.yaml/);
  });

  it('workflow_call は親 runtime の provider/model/options を継承する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Inherit runtime provider options', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'parent-model',
      providerOptions: {
        claude: { allowedTools: ['Read'] },
      },
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('claude');
    expect(options?.resolvedModel).toBe('parent-model');
    expect(options?.providerOptions).toMatchObject({
      claude: {
        allowedTools: ['Read'],
      },
    });
  });

  it('workflow_call は親 step に継承済みの provider 設定を子 workflow に引き継ぐ', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 3,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
            {
              condition: 'ABORT',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Inherited child provider', createWorkflowCallOptions(tmpDir, {
      provider: 'codex',
      model: 'gpt-5-codex',
      providerOptions: {
        codex: { networkAccess: true },
      },
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('codex');
    expect(options?.resolvedModel).toBe('gpt-5-codex');
    expect(options?.providerOptions).toMatchObject({
      codex: {
        networkAccess: true,
      },
    });
  });

  it('workflow_call は step 名と personaProviders の衝突で child 入口 provider を変えない', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 3,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Avoid personaProviders collision on workflow_call', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'parent-model',
      personaProviders: {
        delegate: {
          provider: 'opencode',
          model: 'opencode/delegate-model',
        },
      },
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('claude');
    expect(options?.resolvedModel).toBe('parent-model');
  });

  it('workflow_call wrapper の provider を解決せず child 実 step だけを step event と usage 対象にする', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 1,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    mockPersonaResponses({ reviewer: 'done' });
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    const startedSteps: Array<{
      step: string;
      iteration: number;
      provider: string | undefined;
      model: string | undefined;
      resumeStep: string;
    }> = [];
    engine = new WorkflowEngine(config, tmpDir, 'Run provider-less workflow call wrapper', createWorkflowCallOptions(tmpDir, {
      provider: 'mock',
      model: 'child-model',
    }));
    engine.on('step:start', (step, iteration, _instruction, providerInfo, _workflowName, resumeStepName) => {
      startedSteps.push({
        step: step.name,
        iteration,
        provider: providerInfo.provider,
        model: providerInfo.model,
        resumeStep: resumeStepName,
      });
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(1);
    expect(startedSteps).toEqual([
      {
        step: 'review',
        iteration: 1,
        provider: 'mock',
        model: 'child-model',
        resumeStep: 'delegate',
      },
    ]);
    expect(vi.mocked(runAgent)).toHaveBeenCalledOnce();
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      resolvedProvider: 'mock',
      resolvedModel: 'child-model',
    }));
  });

  it('workflow_call child workflow の AI router は child workflow 名で判定する', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-18T10:00:00.000Z'));
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (persona === 'auto-router') {
        return makeResponse({
          persona: 'auto-router',
          content: '{"required_tier":"medium","reason_codes":["focused-change"],"confidence":null}',
        });
      }
      return makeResponse({
        persona: 'reviewer',
        content: 'done',
      });
    });
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    const childAutoRouting = createQualifiedChildAutoRouting();
    engine = new WorkflowEngine(config, tmpDir, 'Route child workflow with child context', createWorkflowCallOptions(tmpDir, {
      provider: 'mock',
      autoRouting: childAutoRouting,
    }));
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));
    const routingEventsDir = join(tmpDir, '.takt', 'events');
    initAnalyticsWriter(false, join(tmpDir, 'analytics'), { routingEventsDir });
    const analyticsEmitter = new AnalyticsEmitter('run-workflow-call-routing', false);
    engine.on('routing:decision', (step, response, instruction, providerInfo, stepType, durationMs, iteration, workflowName) => {
      analyticsEmitter.onRoutingDecision(
        step,
        response,
        instruction,
        providerInfo,
        stepType,
        durationMs,
        iteration,
        workflowName,
      );
    });

    const state = await engine.run();
    const routerCalls = vi.mocked(runAgent).mock.calls.filter(([persona]) => persona === 'auto-router');
    const routerCall = routerCalls[0];
    const childCall = vi.mocked(runAgent).mock.calls.find(([persona]) => String(persona).includes('reviewer'));

    expect(abortReasons).toEqual([]);
    expect(state.status).toBe('completed');
    expect(routerCalls).toHaveLength(1);
    expect(routerCall?.[1]).toContain('"name":"review"');
    expect(routerCall?.[1]).toContain('"instruction":"Review child workflow"');
    expect(routerCall?.[1]).not.toContain('parent');
    expect(childCall?.[2]).toEqual(expect.objectContaining({
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5',
    }));
    const records = readFileSync(join(routingEventsDir, '2026-02-18.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as RoutingDecisionEvent);
    const childRoutingEvent = records.find((event) => (
      event.type === 'routing_decision' && event.stepName === 'review'
    ));
    expect(childRoutingEvent).toMatchObject({
      type: 'routing_decision',
      stepName: 'review',
      workflowName: 'takt/coding',
      selectedCategory: 'coding',
    });
  });

  it('workflow_call child は親 options の effective auto_routing を継承して未指定 step を routing する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (persona === 'auto-router') {
        return makeResponse({
          persona: 'auto-router',
          content: '{"required_tier":"medium","reason_codes":["focused-change"],"confidence":null}',
        });
      }
      return makeResponse({
        persona: 'reviewer',
        content: 'done',
      });
    });
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    const childAutoRouting = {
      ...createQualifiedChildAutoRouting(),
      defaultPool: undefined,
    };
    engine = new WorkflowEngine(config, tmpDir, 'Route inherited auto provider child workflow', createWorkflowCallOptions(tmpDir, {
      provider: 'mock',
      model: undefined,
      autoRouting: childAutoRouting,
    }));

    const state = await engine.run();
    const childCall = vi.mocked(runAgent).mock.calls.find(([persona]) => String(persona).includes('reviewer'));

    expect(state.status).toBeDefined();
    expect(childCall?.[2]).toEqual(expect.objectContaining({
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5',
    }));
  });

  it('workflow_call は親 runtime auto routing への strategy override を child に一度だけ通知する', async () => {
    const onEffectiveAutoRoutingReached = vi.fn();
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: Review child workflow
    rules:
      - condition: done
        next: COMPLETE
`);
    const parentConfig = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (persona === 'auto-router') {
        return makeResponse({
          persona: 'auto-router',
          content: '{"required_tier":"medium","reason_codes":["focused-change"],"confidence":null}',
        });
      }
      return makeResponse({ persona: 'reviewer', content: 'done' });
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);
    engine = new WorkflowEngine(parentConfig, tmpDir, 'Override child auto strategy', createWorkflowCallOptions(tmpDir, {
      provider: 'mock',
      model: undefined,
      autoRouting: createQualifiedChildAutoRouting(),
      autoStrategyOverride: 'performance',
      onEffectiveAutoRoutingReached,
    }));
    const state = await engine.run();
    const routerCalls = vi.mocked(runAgent).mock.calls.filter(([persona]) => persona === 'auto-router');
    const childCall = vi.mocked(runAgent).mock.calls.find(([persona]) => String(persona).includes('reviewer'));

    expect(state.status).toBe('completed');
    expect(onEffectiveAutoRoutingReached).toHaveBeenCalledTimes(2);
    expect(routerCalls).toHaveLength(1);
    expect(childCall?.[2]).toEqual(expect.objectContaining({
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5',
    }));
  });

  it('workflow_call は strategy override の適用を child engine に委譲する', async () => {
    const parentConfig = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });
    const childConfig = {
      name: 'takt/coding',
      subworkflow: { callable: true },
      initialStep: 'review',
      maxSteps: 5,
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review child workflow',
          rules: [makeRule('done', 'COMPLETE')],
        },
      ],
    };
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
      runWithResult: vi.fn().mockResolvedValue({
        state: {
          workflowName: childConfig.name,
          currentStep: 'review',
          iteration: 2,
          stepOutputs: new Map(),
          structuredOutputs: new Map(),
          systemContexts: new Map(),
          effectResults: new Map(),
          lastOutput: makeResponse({ persona: 'reviewer', content: 'done' }),
          userInputs: [],
          personaSessions: new Map(),
          stepIterations: new Map(),
          status: 'completed',
        },
      }),
    });
    const runner = new WorkflowCallRunner({
      getConfig: () => parentConfig,
      state: {
        workflowName: parentConfig.name,
        currentStep: 'delegate',
        iteration: 1,
        stepOutputs: new Map(),
        structuredOutputs: new Map(),
        systemContexts: new Map(),
        effectResults: new Map(),
        userInputs: [],
        personaSessions: new Map(),
        stepIterations: new Map([['delegate', 1]]),
        status: 'running',
      },
      projectCwd: tmpDir,
      getMaxSteps: () => parentConfig.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Inherit runtime child auto routing',
      getOptions: () => ({
        ...createWorkflowCallOptions(tmpDir),
      provider: 'mock',
      model: undefined,
      autoRouting: createWorkflowCallAutoRoutingConfig(),
      autoRoutingEstimator: { estimate: vi.fn() },
      autoStrategyOverride: 'performance',
      }),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      consumeWorkflowCallContinuation: vi.fn(),
      runPaths: { slug: 'test-report-dir', runRootAbs: tmpDir } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig as never,
      createEngine,
    });

    const step = parentConfig.steps[0] as never;
    const execution = runner.activateInvocation(step, 1, 1, []);
    await expect(runner.run(step, execution)).resolves.toBeDefined();

    expect(createEngine).toHaveBeenCalledWith(
      childConfig,
      tmpDir,
      'Inherit runtime child auto routing',
      expect.objectContaining({
        provider: 'mock',
        autoStrategyOverride: 'performance',
        autoRouting: expect.objectContaining({ strategy: 'balanced' }),
      }),
    );
  });

});
