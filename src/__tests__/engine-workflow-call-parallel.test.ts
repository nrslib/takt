import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
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
import { getWorkflowReference } from '../core/workflow/workflow-reference.js';
import { buildWorkflowCallSiteIdentity } from '../core/workflow/workflow-call-site-identity.js';
import {
  buildWorkflowCallNamespaceSegment,
} from '../core/workflow/workflow-call-namespace.js';
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
  WorkflowConfig,
} from '../core/models/index.js';
import { resetAnalyticsWriter } from '../features/analytics/writer.js';
import type { WorkflowExecutionScope } from '../core/workflow/workflow-execution-scope.js';
import { parseWorkflowResumePoint } from '../core/workflow/resume-point-codec.js';

import {
  createParentWorkflow,
  createWorkflowCallOptions,
  loadWorkflowOrThrow,
  mockPersonaResponses,
  writeWorkflow,
} from './helpers/engine-workflow-call-shared.js';

function expectedWorkflowCallNamespace(
  parentConfig: WorkflowConfig,
  stepName: string,
  occurrence: number,
  childConfig: WorkflowConfig,
): string[] {
  const runPathSegment = buildWorkflowCallSiteIdentity({
    stack: [{
      workflow: parentConfig.name,
      workflow_ref: getWorkflowReference(parentConfig),
      step: stepName,
      kind: 'workflow_call',
      occurrence,
    }],
    childWorkflow: childConfig,
  }).runPathSegment;
  return ['subworkflows', runPathSegment];
}

describe('WorkflowEngine workflow_call parallel execution', () => {
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

  it('parallel 内 workflow_call は child workflow 実行結果を親 parallel 集約へ渡す', async () => {
    writeWorkflow(tmpDir, 'shared/review.yaml', `name: shared/review
subworkflow:
  callable: true
initial_step: child-review
steps:
  - name: child-review
    persona: child-reviewer
    instruction: "Review through child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'reviewers',
      max_steps: 3,
      steps: [
        {
          name: 'reviewers',
          instruction: 'Run reviewers',
          parallel: [
            {
              name: 'delegate-review',
              kind: 'workflow_call',
              call: 'shared/review',
              rules: [
                { condition: 'COMPLETE', next: 'COMPLETE' },
                { condition: 'ABORT', next: 'ABORT' },
              ],
            },
            {
              name: 'local-review',
              persona: 'local-reviewer',
              instruction: 'Review locally',
              rules: [
                { condition: 'COMPLETE', next: 'COMPLETE' },
              ],
            },
          ],
          rules: [
            { condition: 'all("COMPLETE")', next: 'COMPLETE' },
          ],
        },
      ],
    });
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (persona === 'child-reviewer') {
        return makeResponse({ persona, content: 'Child review complete' });
      }
      if (persona === 'local-reviewer') {
        return makeResponse({ persona, content: 'Local review complete' });
      }
      throw new Error(`Unexpected persona: ${String(persona)}`);
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'aggregate' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Run delegated parallel review', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const delegatedOutput = state.stepOutputs.get('delegate-review');
    const parentOutput = state.stepOutputs.get('reviewers');

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
    expect(delegatedOutput?.content).toBe('Child review complete');
    expect(parentOutput?.content).toContain('## delegate-review\nChild review complete');
    expect(parentOutput?.content).toContain('## local-review\nLocal review complete');
  });

  it('workflow_call vars は parallel caller から nested reviewer instruction まで継承される', async () => {
    writeWorkflow(tmpDir, 'shared/nested-review.yaml', `name: shared/nested-review
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: nested-reviewer
    instruction: "mode={var:review_mode}; domain={var:domain}"
    rules:
      - condition: done
        next: COMPLETE
`);
    writeWorkflow(tmpDir, 'shared/review.yaml', `name: shared/review
subworkflow:
  callable: true
initial_step: nested-review
steps:
  - name: nested-review
    kind: workflow_call
    call: shared/nested-review
    vars:
      domain: frontend
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'reviewers',
      max_steps: 4,
      steps: [{
        name: 'reviewers',
        instruction: 'Run reviewers',
        parallel: [{
          name: 'delegate-review',
          kind: 'workflow_call',
          call: 'shared/review',
          vars: {
            review_mode: 'follow_up',
            domain: 'base',
          },
          rules: [
            { condition: 'COMPLETE', next: 'COMPLETE' },
            { condition: 'ABORT', next: 'ABORT' },
          ],
        }, {
          name: 'local-review',
          persona: 'local-reviewer',
          instruction: 'Review locally; mode={var:review_mode}',
          rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
        }],
        rules: [{ condition: 'all("COMPLETE")', next: 'COMPLETE' }],
      }],
    });
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (persona === 'nested-reviewer' || persona === 'local-reviewer') {
        return makeResponse({ persona, content: 'Review complete' });
      }
      throw new Error(`Unexpected persona: ${String(persona)}`);
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'aggregate' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Run nested review', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const nestedPrompt = vi.mocked(runAgent).mock.calls.find(([persona]) => (
      persona === 'nested-reviewer'
    ))?.[1];
    const localPrompt = vi.mocked(runAgent).mock.calls.find(([persona]) => (
      persona === 'local-reviewer'
    ))?.[1];

    expect(state.status).toBe('completed');
    expect(nestedPrompt).toContain('mode=follow_up; domain=frontend');
    expect(nestedPrompt).not.toContain('{var:');
    expect(localPrompt).toContain('mode=unspecified');
  });

  it('initial review の後は follow-up review だけを再実行する', async () => {
    writeWorkflow(tmpDir, 'shared/round-review.yaml', `name: shared/round-review
subworkflow:
  callable: true
  returns:
    - needs_fix
initial_step: review
steps:
  - name: review
    persona: round-reviewer
    instruction: "mode={var:review_mode}"
    rules:
      - condition: needs_fix
        return: needs_fix
      - condition: done
        next: COMPLETE
`);
    const config = createParentWorkflow(tmpDir, {
      name: 'review-do-while',
      initial_step: 'initial-review',
      max_steps: 20,
      steps: [{
        name: 'initial-review',
        kind: 'workflow_call',
        call: 'shared/round-review',
        vars: { review_mode: 'initial' },
        rules: [{ condition: 'COMPLETE', next: 'fix' }],
      }, {
        name: 'fix',
        persona: 'fixer',
        instruction: 'Fix the current findings',
        rules: [{ condition: 'fixed', next: 'follow-up-review' }],
      }, {
        name: 'follow-up-review',
        kind: 'workflow_call',
        call: 'shared/round-review',
        vars: { review_mode: 'follow_up' },
        rules: [
          { condition: 'needs_fix', next: 'fix' },
          { condition: 'COMPLETE', next: 'COMPLETE' },
        ],
      }],
    });
    const reviewPrompts: string[] = [];
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (persona === 'round-reviewer') {
        reviewPrompts.push(prompt);
        return makeResponse({ persona, content: 'Review complete' });
      }
      if (persona === 'fixer') {
        return makeResponse({ persona, content: 'Fix complete' });
      }
      throw new Error(`Unexpected persona: ${String(persona)}`);
    });
    mockRuleEvaluationSequence([
      { index: 1, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 1, method: 'phase3_tag' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Review until complete', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(reviewPrompts.map((prompt) => (
      prompt.match(/mode=(initial|follow_up)/)?.[1]
    ))).toEqual(['initial', 'follow_up', 'follow_up']);
  });

  it('non-interactive parallel workflow_call の no-match は親 fallback rule より先に中断する', async () => {
    writeWorkflow(tmpDir, 'shared/review.yaml', `name: shared/review
subworkflow:
  callable: true
initial_step: child-review
max_steps: 3
steps:
  - name: child-review
    persona: child-reviewer
    instruction: "Review through child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'reviewers',
      max_steps: 3,
      steps: [
        {
          name: 'reviewers',
          instruction: 'Run reviewers',
          parallel: [
            {
              name: 'delegate-review',
              kind: 'workflow_call',
              call: 'shared/review',
              rules: [
                {
                  condition: 'COMPLETE',
                  next: 'COMPLETE',
                  interactive_only: true,
                },
              ],
            },
          ],
          rules: [
            { condition: 'when(true)', next: 'finish' },
          ],
        },
        {
          name: 'finish',
          persona: 'finisher',
          instruction: 'Finish after parent fallback',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    });
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      return makeResponse({ persona: String(persona), content: 'done' });
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'auto_select' },
      { index: 0, method: 'auto_select' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Reject parallel workflow call no-match', createWorkflowCallOptions(tmpDir, {
      interactive: false,
    }));
    const abortFn = vi.fn();
    engine.on('workflow:abort', abortFn);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortFn).toHaveBeenCalledWith(
      expect.anything(),
      'rule_no_match',
      'rule_no_match',
      {
        kind: 'rule_no_match',
        step: 'delegate-review',
        reason: 'rule_no_match',
        error: 'rule_no_match',
      },
    );
    expect(vi.mocked(runAgent).mock.calls.map(([persona]) => persona)).toEqual(['child-reviewer']);
  });

  it('parallel 内 workflow_call 後は親 parallel step の resume point に戻す', async () => {
    writeWorkflow(tmpDir, 'shared/review.yaml', `name: shared/review
subworkflow:
  callable: true
initial_step: child-review
steps:
  - name: child-review
    persona: child-reviewer
    instruction: "Review through child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'reviewers',
      max_steps: 3,
      steps: [
        {
          name: 'reviewers',
          instruction: 'Run reviewers',
          parallel: [
            {
              name: 'delegate-review',
              kind: 'workflow_call',
              call: 'shared/review',
              rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
            },
          ],
          rules: [
            { condition: 'all("COMPLETE")', next: 'COMPLETE' },
          ],
        },
      ],
    });
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (persona === 'child-reviewer') {
        return makeResponse({ persona, content: 'Child review complete' });
      }
      throw new Error(`Unexpected persona: ${String(persona)}`);
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'aggregate' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Run delegated parallel review', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const resumePoint = engine.getResumePoint();

    expect(state.status).toBe('completed');
    expect(resumePoint?.stack).toHaveLength(1);
    expect(resumePoint?.stack[0]).toEqual(expect.objectContaining({
      workflow: 'parent',
      step: 'reviewers',
    }));
  });

  it('parallel 内 workflow_call の iteration limit 延長を親 workflow に同期する', async () => {
    writeWorkflow(tmpDir, 'shared/two-step-review.yaml', `name: shared/two-step-review
subworkflow:
  callable: true
initial_step: child-first
max_steps: 10
steps:
  - name: child-first
    persona: child-reviewer
    instruction: "First child step"
    rules:
      - condition: done
        next: child-second
  - name: child-second
    persona: child-reviewer
    instruction: "Second child step"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'reviewers',
      max_steps: 2,
      steps: [
        {
          name: 'reviewers',
          instruction: 'Run reviewers',
          parallel: [
            {
              name: 'delegate-review',
              kind: 'workflow_call',
              call: 'shared/two-step-review',
              rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
            },
          ],
          rules: [
            { condition: 'all("COMPLETE")', next: 'finish' },
          ],
        },
        {
          name: 'finish',
          persona: 'finisher',
          instruction: 'Finish parent workflow',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    });
    const onIterationLimit = vi.fn().mockResolvedValueOnce(3);
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (prompt.includes('First child step')) {
        return makeResponse({ persona: String(persona), content: 'First child complete' });
      }
      if (prompt.includes('Second child step')) {
        return makeResponse({ persona: String(persona), content: 'Second child complete' });
      }
      if (persona === 'finisher') {
        return makeResponse({ persona, content: 'Parent finish complete' });
      }
      throw new Error(`Unexpected prompt: ${prompt}`);
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'aggregate' },
      { index: 0, method: 'phase3_tag' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Run delegated parallel review', createWorkflowCallOptions(tmpDir, {
      onIterationLimit,
    }));

    const state = await engine.run();

    expect(onIterationLimit).toHaveBeenCalledWith({
      currentIteration: 2,
      maxSteps: 2,
      currentStep: 'child-second',
    });
    expect(state.status).toBe('completed');
    expect(state.lastOutput?.content).toBe('Parent finish complete');
    expect(state.iteration).toBe(4);
  });

  it('parallel fallback retry は非対象 workflow_call の child 固有 provider 解決を維持する', async () => {
    writeWorkflow(tmpDir, 'shared/review.yaml', `name: shared/review
subworkflow:
  callable: true
initial_step: child-review
max_steps: 3
steps:
  - name: child-review
    persona: child-reviewer
    instruction: "Review through child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'reviewers',
      max_steps: 4,
      steps: [
        {
          name: 'reviewers',
          instruction: 'Run reviewers',
          parallel: [
            {
              name: 'delegate-review',
              kind: 'workflow_call',
              call: 'shared/review',
              rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
            },
            {
              name: 'local-review',
              persona: 'local-reviewer',
              instruction: 'Review locally',
              rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
            },
          ],
          rules: [
            { condition: 'all("COMPLETE")', next: 'COMPLETE' },
          ],
        },
      ],
    });
    const childProviderCalls: Array<{ resolvedProvider: string | undefined; resolvedModel: string | undefined }> = [];
    let localAttempts = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (persona === 'child-reviewer') {
        childProviderCalls.push({
          resolvedProvider: options?.resolvedProvider,
          resolvedModel: options?.resolvedModel,
        });
        return makeResponse({ persona, content: 'Child review complete' });
      }
      if (persona === 'local-reviewer') {
        localAttempts += 1;
        if (localAttempts === 1) {
          return makeResponse({
            persona,
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
        }
        return makeResponse({ persona, content: 'Local review complete' });
      }
      throw new Error(`Unexpected persona: ${String(persona)}`);
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'aggregate' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Run delegated parallel review', createWorkflowCallOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
    }));

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(localAttempts).toBe(2);
    expect(childProviderCalls).toEqual([
      { resolvedProvider: 'mock', resolvedModel: 'parent-model' },
      { resolvedProvider: 'mock', resolvedModel: 'parent-model' },
    ]);
  });

  it('parallel 内 workflow_call の解決失敗は parent parallel の error として集約する', async () => {
    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'reviewers',
      max_steps: 3,
      steps: [
        {
          name: 'reviewers',
          instruction: 'Run reviewers',
          parallel: [
            {
              name: 'delegate-review',
              kind: 'workflow_call',
              call: 'missing/review',
              rules: [
                { condition: 'COMPLETE', next: 'COMPLETE' },
              ],
            },
            {
              name: 'local-review',
              persona: 'local-reviewer',
              instruction: 'Review locally',
              rules: [
                { condition: 'COMPLETE', next: 'COMPLETE' },
              ],
            },
          ],
          rules: [
            { condition: 'all("COMPLETE")', next: 'COMPLETE' },
          ],
        },
      ],
    });
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (persona === 'local-reviewer') {
        return makeResponse({ persona, content: 'Local review complete' });
      }
      throw new Error(`Unexpected persona: ${String(persona)}`);
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Run delegated parallel review', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const delegatedOutput = state.stepOutputs.get('delegate-review');
    const parentOutput = state.stepOutputs.get('reviewers');

    expect(state.status).toBe('aborted');
    expect(vi.mocked(runAgent)).toHaveBeenCalledOnce();
    expect(delegatedOutput?.status).toBe('error');
    expect(delegatedOutput?.error).toContain('references unknown workflow "missing/review"');
    expect(parentOutput?.status).toBe('error');
    expect(parentOutput?.content).toContain('delegate-review');
    expect(parentOutput?.content).toContain('references unknown workflow "missing/review"');
    expect(parentOutput?.content).not.toContain('did not return session updates');
  });

  it('parallel 内 workflow_call は更新していない inherited child session を merge しない', async () => {
    writeWorkflow(tmpDir, 'shared/update-session.yaml', `name: shared/update-session
subworkflow:
  callable: true
initial_step: child-review
steps:
  - name: child-review
    persona: child-reviewer
    instruction: "Update inherited session"
    rules:
      - condition: done
        next: COMPLETE
`);
    writeWorkflow(tmpDir, 'shared/inherit-session.yaml', `name: shared/inherit-session
subworkflow:
  callable: true
initial_step: child-review
steps:
  - name: child-review
    persona: child-reviewer
    instruction: "Use inherited session"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'reviewers',
      max_steps: 3,
      steps: [
        {
          name: 'reviewers',
          instruction: 'Run reviewers',
          parallel: [
            {
              name: 'update-delegate',
              kind: 'workflow_call',
              call: 'shared/update-session',
              rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
            },
            {
              name: 'inherit-delegate',
              kind: 'workflow_call',
              call: 'shared/inherit-session',
              rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
            },
          ],
          rules: [
            { condition: 'all("COMPLETE")', next: 'COMPLETE' },
          ],
        },
      ],
    });
    const sessionUpdates = vi.fn();
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (prompt.includes('Update inherited session')) {
        return makeResponse({ persona: String(persona), content: 'Session updated', sessionId: 'updated-session' });
      }
      if (prompt.includes('Use inherited session')) {
        return makeResponse({ persona: String(persona), content: 'Inherited session used', sessionId: undefined });
      }
      throw new Error(`Unexpected prompt: ${prompt}`);
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'aggregate' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Run delegated parallel reviews', createWorkflowCallOptions(tmpDir, {
      initialSessions: {
        '["child-reviewer","mock","parent-model"]': 'initial-session',
      },
      onSessionUpdate: sessionUpdates,
    }));

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.stepOutputs.get('update-delegate')?.content).toBe('Session updated');
    expect(state.stepOutputs.get('inherit-delegate')?.content).toBe('Inherited session used');
    expect(state.personaSessions.get('["child-reviewer","mock","parent-model"]')).toBe('updated-session');
    expect(sessionUpdates).toHaveBeenCalledOnce();
    expect(sessionUpdates).toHaveBeenCalledWith('["child-reviewer","mock","parent-model"]', 'updated-session');
  });

  it('workflow_call の実 child Engine が commit した selection を親 resume point に保持する', async () => {
    writeWorkflow(tmpDir, 'shared/dynamic.yaml', `name: shared/dynamic
subworkflow:
  callable: true
initial_step: reviewers
steps:
  - name: reviewers
    parallel:
      fixed:
        - name: architecture
          persona: architecture
          instruction: Review architecture
          rules:
            - condition: approved
      pool:
        - name: frontend
          persona: frontend
          description: Review frontend changes
          instruction: Review frontend
          rules:
            - condition: approved
    rules:
      - condition: all("approved")
        next: COMPLETE
`);
    const config = createParentWorkflow(tmpDir, {
      name: 'parent-dynamic-selection',
      initial_step: 'delegate',
      max_steps: 5,
      steps: [{
        name: 'delegate',
        kind: 'workflow_call',
        call: 'shared/dynamic',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    });
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: typeof persona === 'string' ? persona : '', userInstruction: prompt });
      return makeResponse({
        persona: typeof persona === 'string' ? persona : 'selector',
        content: 'approved',
        ...(options?.outputSchema === undefined
          ? {}
          : { structuredOutput: { selected_ids: ['frontend'], rationale: 'Frontend review is required.' } }),
      });
    });
    vi.mocked(mockRuleEvaluation).mockImplementation((_step, selection) => ({
      index: 0,
      method: selection === undefined ? 'aggregate' : 'phase3_tag',
    }));
    engine = new WorkflowEngine(config, tmpDir, 'Review frontend changes', createWorkflowCallOptions(tmpDir, {
      selectorProvider: { provider: 'mock', providerOptions: {}, nativeTools: [] },
    }));

    const state = await engine.run();
    const selections = Object.values(engine.getResumePoint()?.dynamic_parallel_selections ?? {});

    expect(state.status, state.lastOutput?.content).toBe('completed');
    expect(selections).toHaveLength(1);
    expect(selections[0]).toMatchObject({
      selected_pool_ids: ['frontend'],
      effective_selection_ids: ['architecture', 'frontend'],
    });
  });

  it('親子の dynamic selection を child round の resume 後も個別に復元する', async () => {
    writeWorkflow(tmpDir, 'shared/child-dynamic.yaml', `name: shared/child-dynamic
subworkflow:
  callable: true
initial_step: child-reviewers
max_steps: 1
steps:
  - name: child-reviewers
    parallel:
      fixed:
        - name: child-architecture
          persona: child-architecture
          instruction: Review child architecture
          rules:
            - condition: approved
      pool:
        - name: frontend
          persona: frontend
          description: Review frontend changes
          instruction: Review frontend
          rules:
            - condition: approved
    rules:
      - condition: all("approved")
        next: COMPLETE
`);
    const config = createParentWorkflow(tmpDir, {
      name: 'parent-and-child-dynamic',
      initial_step: 'parent-reviewers',
      max_steps: 5,
      steps: [
        {
          name: 'parent-reviewers',
          parallel: {
            fixed: [{
              name: 'parent-architecture',
              persona: 'parent-architecture',
              instruction: 'Review parent architecture',
              rules: [{ condition: 'approved' }],
            }],
            pool: [{
              name: 'api',
              persona: 'api',
              description: 'Review API changes',
              instruction: 'Review API',
              rules: [{ condition: 'approved' }],
            }],
          },
          rules: [{ condition: 'all("approved")', next: 'delegate' }],
        },
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'shared/child-dynamic',
          rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
        },
      ],
    });
    const childConfig = loadWorkflowOrThrow('shared/child-dynamic', tmpDir);
    const persisted: import('../core/models/types.js').WorkflowResumePoint[] = [];
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      const selectedId = options?.outputSchema === undefined
        ? undefined
        : JSON.stringify(options.outputSchema).includes('"api"') ? 'api' : 'frontend';
      return makeResponse({
        persona: typeof persona === 'string' ? persona : 'selector',
        content: 'approved',
        ...(selectedId === undefined
          ? {}
          : { structuredOutput: { selected_ids: [selectedId], rationale: 'Required review.' } }),
      });
    });
    vi.mocked(mockRuleEvaluation).mockImplementation((_step, selection) => ({
      index: 0,
      method: selection === undefined ? 'aggregate' : 'phase3_tag',
    }));
    engine = new WorkflowEngine(config, tmpDir, 'Review parent and child changes', createWorkflowCallOptions(tmpDir, {
      selectorProvider: { provider: 'mock', providerOptions: {}, nativeTools: [] },
      onDynamicParallelSelectionPersisted: (resumePoint) => {
        persisted.push(resumePoint);
      },
    }));

    const firstState = await engine.run();
    const childRoundResumePoint = persisted.at(-1);
    if (childRoundResumePoint === undefined) {
      throw new Error('Expected the child dynamic round resume point');
    }

    expect(firstState.status, firstState.lastOutput?.content).toBe('completed');
    expect(Object.values(childRoundResumePoint.dynamic_parallel_selections ?? {})).toHaveLength(2);
    expect(childRoundResumePoint.stack.map((entry) => entry.step)).toEqual([
      'delegate',
      'child-reviewers',
    ]);
    expect(Object.values(childRoundResumePoint.workflow_call_invocations ?? {})).toEqual([
      expect.objectContaining({
        call_instance: 1,
        report_namespace_segment: expectedWorkflowCallNamespace(
          config,
          'delegate',
          1,
          childConfig,
        )[1],
      }),
    ]);

    vi.mocked(runAgent).mockClear();
    engine = new WorkflowEngine(config, tmpDir, 'Resume child review', createWorkflowCallOptions(tmpDir, {
      selectorProvider: { provider: 'mock', providerOptions: {}, nativeTools: [] },
      resumePoint: childRoundResumePoint,
      startStep: childRoundResumePoint.stack[0]?.step,
      initialIteration: childRoundResumePoint.iteration,
    }));
    const resumedState = await engine.run();
    const resumedSelections = [...resumedState.dynamicParallelSelections.values()];
    const selectorCalls = vi.mocked(runAgent).mock.calls
      .filter(([, , options]) => options?.outputSchema !== undefined);

    expect(resumedState.status, resumedState.lastOutput?.content).toBe('completed');
    expect(selectorCalls).toHaveLength(0);
    expect(resumedSelections).toHaveLength(2);
    expect(resumedSelections.map((selection) => selection.selected_pool_ids))
      .toEqual(expect.arrayContaining([['api'], ['frontend']]));
  });

  it('parallel sibling workflow_call child Engines retain both canonical selections in the parent resume point', async () => {
    const writeDynamicChild = (name: string, selectedPoolId: string) => writeWorkflow(tmpDir, `shared/${name}.yaml`, `name: shared/${name}
subworkflow:
  callable: true
initial_step: reviewers
steps:
  - name: reviewers
    parallel:
      fixed:
        - name: architecture
          persona: architecture-${name}
          instruction: Review architecture
          rules:
            - condition: approved
      pool:
        - name: ${selectedPoolId}
          persona: ${selectedPoolId}
          description: Review ${selectedPoolId} changes
          instruction: Review ${selectedPoolId}
          rules:
            - condition: approved
    rules:
      - condition: all("approved")
        next: COMPLETE
`);
    writeDynamicChild('left', 'frontend');
    writeDynamicChild('right', 'backend');
    const config = createParentWorkflow(tmpDir, {
      name: 'parent-parallel-dynamic-selections',
      initial_step: 'delegates',
      max_steps: 5,
      steps: [{
        name: 'delegates',
        parallel: [
          { name: 'left-call', kind: 'workflow_call', call: 'shared/left', rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }] },
          { name: 'right-call', kind: 'workflow_call', call: 'shared/right', rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }] },
        ],
        rules: [{ condition: 'all("COMPLETE")', next: 'COMPLETE' }],
      }],
    });
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: typeof persona === 'string' ? persona : '', userInstruction: prompt });
      const selectedId = options?.outputSchema !== undefined
        && JSON.stringify(options.outputSchema).includes('backend')
        ? 'backend'
        : 'frontend';
      return makeResponse({
        persona: typeof persona === 'string' ? persona : 'selector',
        content: 'approved',
        ...(options?.outputSchema === undefined
          ? {}
          : { structuredOutput: { selected_ids: [selectedId], rationale: 'Required review.' } }),
      });
    });
    vi.mocked(mockRuleEvaluation).mockImplementation((_step, selection) => ({
      index: 0,
      method: selection === undefined ? 'aggregate' : 'phase3_tag',
    }));
    engine = new WorkflowEngine(config, tmpDir, 'Review frontend and backend changes', createWorkflowCallOptions(tmpDir, {
      selectorProvider: { provider: 'mock', providerOptions: {}, nativeTools: [] },
    }));
    const state = await engine.run();
    const selections = Object.values(engine.getResumePoint()?.dynamic_parallel_selections ?? {});

    expect(state.status, state.lastOutput?.content).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(6);
    expect(selections.map((selection) => selection.selected_pool_ids)).toEqual(expect.arrayContaining([
      ['frontend'],
      ['backend'],
    ]));
    expect(new Set(selections.map((selection) => selection.identity)).size).toBe(2);
  });

});
