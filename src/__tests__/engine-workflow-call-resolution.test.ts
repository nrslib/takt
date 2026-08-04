import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

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
  loadWorkflowByIdentifier,
  resolveWorkflowCallTarget,
} from '../infra/config/index.js';
import { getWorkflowTrustInfo } from '../infra/config/loaders/workflowTrustSource.js';
import {
  applyDefaultMocks,
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeRule,
  makeResponse,
  mockRuleEvaluationSequence,
} from './engine-test-helpers.js';
import { findWorkflowCallStep } from './testUtils/workflowCallStepTestHelper.js';
import type {
  WorkflowConfig,
  WorkflowStep,
} from '../core/models/index.js';
import { resetAnalyticsWriter } from '../features/analytics/writer.js';
import { generateReportDir } from '../shared/utils/index.js';
import type { WorkflowExecutionScope } from '../core/workflow/workflow-execution-scope.js';

import {
  createParentWorkflow,
  createWorkflowCallOptions,
  loadWorkflowOrThrow,
  mockPersonaResponses,
  writeWorkflow,
} from './helpers/engine-workflow-call-shared.js';

describe('WorkflowEngine workflow_call resolution and trust', () => {
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

  it('callable ではない child workflow を拒否する', async () => {
    writeWorkflow(tmpDir, 'child.yaml', `name: child
initial_step: review
max_steps: 5
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
          call: 'child',
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

    engine = new WorkflowEngine(config, tmpDir, 'Reject non-callable child', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it.each([2, 'infinite'] as const)(
    'resolver が返す callable child の maxSteps %s を child agent 起動前に拒否する',
    async (maxSteps) => {
      const config = createParentWorkflow(tmpDir, {
        name: 'parent',
        initial_step: 'delegate',
        max_steps: 3,
        steps: [{
          name: 'delegate',
          kind: 'workflow_call',
          call: 'child',
          rules: [
            { condition: 'COMPLETE', next: 'COMPLETE' },
            { condition: 'ABORT', next: 'ABORT' },
          ],
        }],
      });
      const childConfig: WorkflowConfig = {
        name: 'child',
        subworkflow: { callable: true },
        maxSteps,
        initialStep: 'review',
        steps: [{
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review',
          rules: [makeRule('done', 'COMPLETE')],
        }],
      };
      let abortReason = '';
      engine = new WorkflowEngine(config, tmpDir, 'Reject callable child maxSteps', createWorkflowCallOptions(tmpDir, {
        workflowCallResolver: () => childConfig,
      }));
      engine.on('workflow:abort', (_state, reason) => {
        abortReason = reason;
      });

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortReason).toMatch(/callable.*max_steps|max_steps.*callable/i);
      expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    },
  );

  it('workflow call context なしで callable subworkflow を直接実行する場合は開始前に拒否する', () => {
    const config = createParentWorkflow(tmpDir, {
      name: 'shared/review',
      subworkflow: { callable: true },
      initial_step: 'review',
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review child workflow',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    });

    expect(() => {
      engine = new WorkflowEngine(
        config,
        tmpDir,
        'Reject direct callable execution',
        createWorkflowCallOptions(tmpDir),
      );
    }).toThrow(/callable.*workflow_call|workflow_call.*callable/i);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('公開 resume prefix を偽装しても callable subworkflow の直接実行を副作用前に拒否する', () => {
    const config = createParentWorkflow(tmpDir, {
      name: 'shared/review',
      subworkflow: { callable: true },
      initial_step: 'review',
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review child workflow',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    });
    vi.mocked(generateReportDir).mockClear();

    expect(() => {
      engine = new WorkflowEngine(
        config,
        tmpDir,
        'Reject forged call context',
        createWorkflowCallOptions(tmpDir, {
          resumeStackPrefix: [{
            workflow: 'forged-parent',
            step: 'delegate',
            kind: 'workflow_call',
            call_instance: 1,
          }],
        }),
      );
    }).toThrow(/callable.*workflow_call|workflow_call.*callable/i);
    expect(vi.mocked(generateReportDir)).not.toHaveBeenCalled();
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('イベント listener が step と scope の snapshot を変更できない', async () => {
    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'review',
      max_steps: 1,
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review task',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    });
    mockPersonaResponses({ reviewer: 'done' });
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);
    engine = new WorkflowEngine(config, tmpDir, 'Snapshot events', createWorkflowCallOptions(tmpDir));
    const observed = vi.fn();
    engine.on('phase:start', (step: WorkflowStep, ...args: unknown[]) => {
      const scope = args.at(-1) as WorkflowExecutionScope;
      expect(Object.isFrozen(step)).toBe(true);
      expect(Object.isFrozen(scope.stack)).toBe(true);
      expect(() => {
        (step as { name: string }).name = 'mutated';
      }).toThrow();
      expect(() => {
        (scope.stack[0] as { step: string }).step = 'mutated';
      }).toThrow();
    });
    engine.on('phase:start', (step: WorkflowStep, ...args: unknown[]) => {
      const scope = args.at(-1) as WorkflowExecutionScope;
      observed(step.name, scope.stack[0]?.step);
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(observed).toHaveBeenCalledWith('review', 'review');
    expect(config.steps[0]?.name).toBe('review');
  });

  it('workflow_call cycle を検出して停止する', async () => {
    writeWorkflow(tmpDir, 'a.yaml', `name: a
subworkflow:
  callable: true
initial_step: delegate
steps:
  - name: delegate
    kind: workflow_call
    call: b
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);
    writeWorkflow(tmpDir, 'b.yaml', `name: b
subworkflow:
  callable: true
initial_step: delegate
steps:
  - name: delegate
    kind: workflow_call
    call: a
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const rootConfig = createParentWorkflow(tmpDir, {
      name: 'root',
      max_steps: 1,
      initial_step: 'delegate',
      steps: [{
        name: 'delegate',
        kind: 'workflow_call',
        call: 'a',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    });
    engine = new WorkflowEngine(rootConfig, tmpDir, 'Detect workflow call cycle', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('workflow_call depth 制限を超えたら停止する', async () => {
    for (let index = 1; index <= 6; index++) {
      const nextName = `w${index + 1}`;
      writeWorkflow(tmpDir, `w${index}.yaml`, index < 6
        ? `name: w${index}
subworkflow:
  callable: true
initial_step: delegate
steps:
  - name: delegate
    kind: workflow_call
    call: ${nextName}
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`
        : `name: w${index}
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Deep child"
    rules:
      - condition: done
        next: COMPLETE
`);
    }

    const rootConfig = createParentWorkflow(tmpDir, {
      name: 'root',
      max_steps: 1,
      initial_step: 'delegate',
      steps: [{
        name: 'delegate',
        kind: 'workflow_call',
        call: 'w1',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    });
    engine = new WorkflowEngine(rootConfig, tmpDir, 'Detect workflow depth limit', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'when rule',
      rule: 'condition: "when(true)"\n        next: COMPLETE',
    },
    {
      label: 'ai() condition',
      rule: 'condition: ai("route to plan")\n        next: COMPLETE',
    },
  ])('loadWorkflowOrThrow は workflow_call の不正な $label を実行前に reject する', ({ rule }) => {
    writeWorkflow(tmpDir, 'invalid-parent.yaml', `name: invalid-parent
initial_step: delegate
max_steps: 5
steps:
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - ${rule}
`);

    expect(() => loadWorkflowOrThrow('invalid-parent', tmpDir)).toThrow();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('project workflow から project 外の privileged subworkflow 呼び出しを拒否する', async () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalWorkflowPath = join(externalDir, 'privileged-child.yaml');
    writeFileSync(externalWorkflowPath, `name: privileged-child
subworkflow:
  callable: true
initial_step: route_context
steps:
  - name: route_context
    kind: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - condition: when(true)
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ${externalWorkflowPath}
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const workflowAborted = vi.fn();
    engine = new WorkflowEngine(
      loadWorkflowOrThrow('parent', tmpDir),
      tmpDir,
      'Block privileged child',
      createWorkflowCallOptions(tmpDir),
    );
    engine.on('workflow:abort', workflowAborted);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(workflowAborted.mock.calls.map(([, reason]) => reason)).toEqual([
      expect.stringContaining('Workflow step "delegate" cannot call privileged workflow "privileged-child" across trust boundary'),
    ]);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('relative child path は呼び出し元 workflow のディレクトリ基準で解決する', async () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalParentPath = join(externalDir, 'parent.yaml');
    writeFileSync(externalParentPath, `name: external-parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ./child.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    writeFileSync(join(externalDir, 'child.yaml'), `name: external-child
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: external-reviewer
    instruction: "External child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeFileSync(join(tmpDir, 'child.yaml'), `name: project-child
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: project-reviewer
    instruction: "Project child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'external-reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(loadWorkflowOrThrow(externalParentPath, tmpDir), tmpDir, 'Resolve relative child from parent dir', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const calledPersona = vi.mocked(runAgent).mock.calls[0]?.[0];

    expect(state.status).toBeDefined();
    expect(calledPersona).toContain('external-reviewer');
  });

  it('external parent の plain identifier も project -> user -> builtin の順で解決する', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalParentPath = join(externalDir, 'parent.yaml');
    writeFileSync(externalParentPath, `name: external-parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    mkdirSync(dirname(join(externalDir, 'takt', 'coding.yaml')), { recursive: true });
    writeFileSync(join(externalDir, 'takt', 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: external-reviewer
    instruction: "External child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: project-reviewer
    instruction: "Project child"
    rules:
      - condition: done
        next: COMPLETE
`);
    const userWorkflowDir = join(configDir, 'workflows', 'takt');
    mkdirSync(userWorkflowDir, { recursive: true });
    writeFileSync(join(userWorkflowDir, 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: user-reviewer
    instruction: "User child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const parentWorkflow = loadWorkflowOrThrow(externalParentPath, tmpDir);
    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'project-reviewer',
    });
  });

  it('external parent の named child は project 不在時に user workflow を優先する', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalParentPath = join(externalDir, 'parent.yaml');
    writeFileSync(externalParentPath, `name: external-parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    mkdirSync(dirname(join(externalDir, 'takt', 'coding.yaml')), { recursive: true });
    writeFileSync(join(externalDir, 'takt', 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: external-reviewer
    instruction: "External child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const userWorkflowDir = join(configDir, 'workflows', 'takt');
    mkdirSync(userWorkflowDir, { recursive: true });
    writeFileSync(join(userWorkflowDir, 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: user-reviewer
    instruction: "User child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const parentWorkflow = loadWorkflowOrThrow(externalParentPath, tmpDir);
    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'user-reviewer',
    });
  });

  it('project parent の named child は user workflow へ fallback できる', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const userWorkflowDir = join(configDir, 'workflows', 'takt');
    mkdirSync(userWorkflowDir, { recursive: true });
    writeFileSync(join(userWorkflowDir, 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: user-reviewer
    instruction: "User child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'user-reviewer',
    });
  });

  it('project parent の named child は user workflow fallback 先の allow_git_commit を trust boundary で拒否する', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const userWorkflowDir = join(configDir, 'workflows', 'takt');
    mkdirSync(userWorkflowDir, { recursive: true });
    writeFileSync(join(userWorkflowDir, 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: user-reviewer
    allow_git_commit: true
    instruction: "User child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    expect(() => resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    )).toThrow(
      'Workflow step "delegate" cannot call privileged workflow "takt/coding" across trust boundary',
    );
  });

  it('source metadata を持たない project parent も user workflow fallback を解決できる', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const userWorkflowDir = join(configDir, 'workflows', 'takt');
    mkdirSync(userWorkflowDir, { recursive: true });
    writeFileSync(join(userWorkflowDir, 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: user-reviewer
    instruction: "User child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const parentWorkflow = createParentWorkflow(tmpDir, {
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
              next: 'ABORT',
            },
          ],
        },
      ],
    });

    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'user-reviewer',
    });
  });

  it('project parent の named child は builtin fallback を trust boundary で拒否する', () => {
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: default
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('default');
  });

  it('project parent は project workflow root 内 child の explicit path を呼べる', () => {
    writeWorkflow(tmpDir, 'child.yaml', `name: project-child
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: project-reviewer
    instruction: "Project child"
    rules:
      - condition: done
        next: COMPLETE
`);
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ./child.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);
    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('project-child');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'project-reviewer',
    });
  });

  it('project parent は absolute child path を既存どおり解決できる', () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalWorkflowPath = join(externalDir, 'child.yaml');
    writeFileSync(externalWorkflowPath, `name: external-child
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: external-reviewer
    instruction: "External child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ${externalWorkflowPath}
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('external-child');
  });

  it('project parent は tilde child path を既存どおり解決できる', async () => {
    const fakeHomeDir = createTestTmpDir();
    cleanupDirs.push(fakeHomeDir);
    const testWorkflowDir = join(fakeHomeDir, '.takt', 'workflows', 'workflow-call-tilde-test');
    const userWorkflowPath = join(testWorkflowDir, 'external.yaml');
    mkdirSync(testWorkflowDir, { recursive: true });
    writeFileSync(userWorkflowPath, `name: tilde-child
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: tilde-reviewer
    instruction: "Tilde child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    const parentWorkflow = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 3,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: '~/.takt/workflows/workflow-call-tilde-test/external.yaml',
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

    vi.resetModules();
    vi.doMock('node:os', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:os')>()),
      homedir: () => fakeHomeDir,
    }));

    const { resolveWorkflowCallTarget: resolveWorkflowCallTargetWithMockedHomedir } = await import('../infra/config/loaders/workflowCallResolver.js');

    const childWorkflow = resolveWorkflowCallTargetWithMockedHomedir(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('tilde-child');
    vi.doUnmock('node:os');
    vi.resetModules();
  });

  it('project parent は dot-segment を含む named child identifier を reject する', () => {
    mkdirSync(join(tmpDir, '.takt'), { recursive: true });
    writeFileSync(join(tmpDir, '.takt', 'outside.yaml'), `name: escaped-child
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: escaped-reviewer
    instruction: "Escaped child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/../../outside
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    expect(() => resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    )).toThrow(
      'Workflow step "delegate" cannot call invalid workflow identifier "takt/../../outside"',
    );
  });

  it('project parent は @scope ref を既存どおり解決できる', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const workflowsDir = join(configDir, 'repertoire', '@nrslib', 'takt-ensemble', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'expert.yaml'), `name: external-child
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: external-reviewer
    instruction: "External child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: "@nrslib/takt-ensemble/expert"
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('external-child');
  });

  it('project parent は project に存在しない named child の user fallback を許可する', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const userWorkflowDir = join(configDir, 'workflows', 'takt');
    mkdirSync(userWorkflowDir, { recursive: true });
    writeFileSync(join(userWorkflowDir, 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: external-reviewer
    instruction: "User child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'external-reviewer',
    });
  });

  it('default worktree root 上の parent path は worktree workflow を non-project trust として解決する', () => {
    const worktreeRoot = join(tmpDir, '..', 'takt-worktrees', basename(tmpDir));
    const worktreeDir = join(worktreeRoot, 'feature-branch');
    cleanupDirs = [...cleanupDirs, worktreeRoot];
    const worktreeWorkflowPath = join(worktreeDir, '.takt', 'workflows', 'parent.yaml');
    mkdirSync(dirname(worktreeWorkflowPath), { recursive: true });
    writeFileSync(worktreeWorkflowPath, `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ./takt/coding.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    mkdirSync(join(worktreeDir, '.takt', 'workflows', 'takt'), { recursive: true });
    writeFileSync(join(worktreeDir, '.takt', 'workflows', 'takt', 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: worktree-reviewer
    instruction: "Worktree child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const parentWorkflow = loadWorkflowByIdentifier('./.takt/workflows/parent.yaml', tmpDir, { lookupCwd: worktreeDir });
    expect(parentWorkflow).not.toBeNull();
    expect(getWorkflowTrustInfo(parentWorkflow!, tmpDir)).toMatchObject({
      source: 'worktree',
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    });

    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow!,
      findWorkflowCallStep(parentWorkflow!, 'delegate'),
      tmpDir,
      worktreeDir,
    );

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'worktree-reviewer',
    });
    expect(getWorkflowTrustInfo(childWorkflow!, tmpDir)).toMatchObject({
      source: 'worktree',
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    });
  });

  it('default worktree root 上の parent path は user fallback child を許可する', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const userWorkflowDir = join(configDir, 'workflows', 'takt');
    mkdirSync(userWorkflowDir, { recursive: true });
    writeFileSync(join(userWorkflowDir, 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: user-reviewer
    instruction: "User child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const worktreeRoot = join(tmpDir, '..', 'takt-worktrees', basename(tmpDir));
    const worktreeDir = join(worktreeRoot, 'feature-branch');
    cleanupDirs = [...cleanupDirs, worktreeRoot];
    const worktreeWorkflowPath = join(worktreeDir, '.takt', 'workflows', 'parent.yaml');
    mkdirSync(dirname(worktreeWorkflowPath), { recursive: true });
    writeFileSync(worktreeWorkflowPath, `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');

    const parentWorkflow = loadWorkflowByIdentifier('./.takt/workflows/parent.yaml', tmpDir, { lookupCwd: worktreeDir });
    expect(parentWorkflow).not.toBeNull();

    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow!,
      findWorkflowCallStep(parentWorkflow!, 'delegate'),
      tmpDir,
      worktreeDir,
    );

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'user-reviewer',
    });
  });

  it('project parent は privileged な external child path を拒否する', () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalWorkflowPath = join(externalDir, 'child.yaml');
    writeFileSync(externalWorkflowPath, `name: external-child
subworkflow:
  callable: true
initial_step: route_context
steps:
  - name: route_context
    kind: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - condition: when(true)
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ${externalWorkflowPath}
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    expect(() => resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    )).toThrow(
      'Workflow step "delegate" cannot call privileged workflow "external-child" across trust boundary',
    );
  });

  it('project parent は allow_git_commit を持つ external child path を拒否する', () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalWorkflowPath = join(externalDir, 'child.yaml');
    writeFileSync(externalWorkflowPath, `name: external-child
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: external-reviewer
    allow_git_commit: true
    instruction: "External child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ${externalWorkflowPath}
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    expect(() => resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    )).toThrow(
      'Workflow step "delegate" cannot call privileged workflow "external-child" across trust boundary',
    );
  });

  it('non-project parent から project child path を呼ぶ場合も path 解決できる', () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalParentPath = join(externalDir, 'parent.yaml');
    writeFileSync(externalParentPath, `name: external-parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: project-reviewer
    instruction: "Project child"
    rules:
      - condition: done
        next: COMPLETE
`);
    const parentWorkflow = loadWorkflowOrThrow(externalParentPath, tmpDir);
    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'project-reviewer',
    });
  });

  it('non-project parent から privileged な project child を named lookup で呼ぶと拒否する', () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalParentPath = join(externalDir, 'parent.yaml');
    writeFileSync(externalParentPath, `name: external-parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: route_context
steps:
  - name: route_context
    kind: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - condition: when(true)
        next: COMPLETE
`);

    const parentWorkflow = loadWorkflowOrThrow(externalParentPath, tmpDir);

    expect(() => resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    )).toThrow(
      'Workflow step "delegate" cannot call privileged workflow "takt/coding" across trust boundary',
    );
  });
});
