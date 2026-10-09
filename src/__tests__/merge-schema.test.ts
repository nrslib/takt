import { describe, expect, it } from 'vitest';
import { GlobalConfigSchema, ProjectConfigSchema, WorkflowConfigRawSchema, WorkflowStepRawSchema } from '../core/models/index.js';
import { validateDoctorGraph } from '../infra/config/loaders/workflowDoctorGraph.js';
import type { WorkflowDiagnostic } from '../infra/config/loaders/workflowDoctorTypes.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { validateWorkflowConfig } from '../core/workflow/engine/WorkflowValidator.js';
import { denormalizeMergeConfig } from '../infra/config/configNormalizers.js';

describe('Merge configuration schema', () => {
  it('merge設定を保存形式へ戻し省略値とfalseを保持する', () => {
    expect(denormalizeMergeConfig(undefined)).toBeUndefined();
    expect(denormalizeMergeConfig({ method: 'squash', autoStart: false, includeDraft: true,
      includeForks: false, threatCheckMaxDiffBytes: 100,
      workflow: 'merge-review', where: { author: 'alice' } })).toEqual({
      method: 'squash', auto_start: false, include_draft: true,
      include_forks: false, threat_check_max_diff_bytes: 100,
      workflow: 'merge-review', where: { author: 'alice' },
    });
    expect(denormalizeMergeConfig({})).toEqual({});
  });
  it.each([['project', ProjectConfigSchema], ['global', GlobalConfigSchema]] as const)(
    '%s設定でmergeの選定条件・workflow・方式・独立した自動起動を受理する', (_scope, schema) => {
      const merge = {
        workflow: 'merge-review', method: 'rebase', auto_start: true, include_draft: true,
        where: { author: 'author', labels: ['ready', 'automation'], base_branch: 'main',
          head_branch: 'takt/*', managed_by_takt: true, same_repository: true },
      };
      expect(schema.parse({ merge, caccia: { enabled: false } })).toMatchObject({ merge: {
        workflow: merge.workflow, method: merge.method, autoStart: true, includeDraft: true, where: merge.where,
      } });
    },
  );

  it.each(['squash', 'merge', 'rebase'])('マージ方式%sを受理する', (method) => {
    expect(ProjectConfigSchema.parse({ merge: { method } })).toMatchObject({ merge: { method } });
  });

  it('契約外のマージ方式を拒否する', () => {
    expect(ProjectConfigSchema.safeParse({ merge: { method: 'fast-forward' } }).success).toBe(false);
  });

  it.each([0, -1, 1.5, '100'])('不正な差分上限%jを拒否する', (value) => {
    expect(ProjectConfigSchema.safeParse({ merge: { threat_check_max_diff_bytes: value } }).success).toBe(false);
  });
});

describe('System step wait transition validation', () => {
  function diagnostics(timeoutTarget: string) {
    const raw = WorkflowConfigRawSchema.parse({ name: 'wait-graph', initial_step: 'wait_external', steps: [
      { name: 'wait_external', mode: 'system',
        system_inputs: [{ type: 'task_context', source: 'current_task', as: 'external' }],
        wait: { until: 'when(context.wait_external.external.exists == true)', on_timeout: timeoutTarget },
        rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      { name: 'timeout', mode: 'system', rules: [{ condition: 'when(true)', next: 'ABORT' }] },
    ] });
    const result: WorkflowDiagnostic[] = [];
    validateDoctorGraph(raw, result);
    return result;
  }

  it('タイムアウトだけから到達するstepを到達不能と診断しない', () => {
    expect(diagnostics('timeout')).toEqual([]);
  });

  it('存在しないタイムアウト遷移先をwaitの設定箇所で診断する', () => {
    expect(diagnostics('missing')).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'error', path: ['steps', 0, 'wait', 'on_timeout'] }),
    ]));
  });
});

describe('System step wait schema', () => {
  const rawStep = {
    name: 'wait_external', mode: 'system',
    system_inputs: [{ type: 'task_context', source: 'current_task', as: 'external' }],
    rules: [{ condition: 'when(true)', next: 'COMPLETE' }],
  };

  it('条件・間隔・上限回数・タイムアウト遷移をYAML入力から保持する', () => {
    const wait = { until: 'when(context.wait_external.external.exists == true)',
      interval_ms: 20, max_retries: 3, on_timeout: 'comment_timeout' };
    expect(WorkflowStepRawSchema.parse({ ...rawStep, wait })).toMatchObject({ wait });
  });

  it.each([
    { interval_ms: -1 }, { interval_ms: 0 }, { interval_ms: 2_147_483_648 },
    { max_retries: -1 }, { max_retries: 1.5 }, { max_retries: Number.MAX_SAFE_INTEGER + 1 },
  ])('不正な待機属性%jを拒否する', (invalid) => {
    const wait = { until: 'when(true)', interval_ms: 15_000, max_retries: 120, on_timeout: 'ABORT', ...invalid };
    expect(WorkflowStepRawSchema.safeParse({ ...rawStep, wait }).success).toBe(false);
  });

  it('PR状態のsystem inputを受理する', () => {
    const input = { type: 'pr_status', source: 'current_pr', as: 'status' };
    expect(WorkflowStepRawSchema.parse({ ...rawStep, system_inputs: [input] })).toMatchObject({ system_inputs: [input] });
  });

  it.each([1, 15_000, 2_147_483_647, undefined])('有効な間隔%sを正規化と実行時検証で保持する', (interval_ms) => {
    const workflow = normalizeWorkflowConfig({ name: 'valid-interval', initial_step: rawStep.name,
      steps: [{ ...rawStep, wait: { until: 'when(false)', interval_ms, on_timeout: 'ABORT' } }],
    }, process.cwd());
    const step = workflow.steps[0]!;
    if (step.kind !== 'system') throw new Error('Expected system step');
    expect(step.wait?.intervalMs).toBe(interval_ms ?? 15_000);
    expect(step.wait?.maxRetries).toBe(120);
    expect(() => validateWorkflowConfig(workflow, { projectCwd: '/project' })).not.toThrow();
  });

  it.each([0, -1, 1.5, 2_147_483_648])('直接構築した設定でも不正な間隔%sを拒否する', (intervalMs) => {
    const workflow = normalizeWorkflowConfig({ name: 'invalid-interval', initial_step: rawStep.name,
      steps: [{ ...rawStep, wait: { until: 'when(false)', on_timeout: 'ABORT' } }],
    }, process.cwd());
    const step = workflow.steps[0]!;
    if (step.kind !== 'system') throw new Error('Expected system step');
    step.wait!.intervalMs = intervalMs;
    expect(() => validateWorkflowConfig(workflow, { projectCwd: '/project' })).toThrow();
  });

  it('commitとpushのsystem effectを受理する', () => {
    const effect = { type: 'commit_and_push', pr: 123 };
    expect(WorkflowStepRawSchema.parse({ ...rawStep, effects: [effect] })).toMatchObject({ effects: [effect] });
  });

  it.each([0, 2, Number.MAX_SAFE_INTEGER, undefined])('有効な再試行上限%sをraw入力から実行時検証まで保持する', (max_retries) => {
    const workflow = normalizeWorkflowConfig({ name: 'valid-retries', initial_step: rawStep.name,
      steps: [{ ...rawStep, wait: { until: 'when(false)', max_retries, on_timeout: 'ABORT' } }],
    }, process.cwd());
    const step = workflow.steps[0]!;
    if (step.kind !== 'system') throw new Error('Expected system step');
    expect(step.wait?.maxRetries).toBe(max_retries ?? 120);
    expect(() => validateWorkflowConfig(workflow, { projectCwd: '/project' })).not.toThrow();
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('直接構築した設定でも不正な再試行上限%sを拒否する', (maxRetries) => {
    const workflow = normalizeWorkflowConfig({ name: 'invalid-retries', initial_step: rawStep.name,
      steps: [{ ...rawStep, wait: { until: 'when(false)', on_timeout: 'ABORT' } }],
    }, process.cwd());
    const step = workflow.steps[0]!;
    if (step.kind !== 'system') throw new Error('Expected system step');
    step.wait!.maxRetries = maxRetries;
    expect(() => validateWorkflowConfig(workflow, { projectCwd: '/project' })).toThrow();
  });

  it('waitの意味ラベルとagent stepへのwait指定を拒否する', () => {
    expect(WorkflowStepRawSchema.safeParse({ ...rawStep, wait: { until: 'ready', on_timeout: 'ABORT' } }).success).toBe(false);
    expect(WorkflowStepRawSchema.safeParse({ name: 'agent', instruction: 'Work',
      wait: { until: 'when(true)', on_timeout: 'ABORT' } }).success).toBe(false);
  });

  it('実行時にも存在しないタイムアウト遷移先を拒否する', () => {
    const workflow = normalizeWorkflowConfig({ name: 'invalid-timeout', initial_step: rawStep.name,
      steps: [{ ...rawStep, wait: { until: 'when(false)', on_timeout: 'missing' } }],
    }, process.cwd());
    expect(() => validateWorkflowConfig(workflow, { projectCwd: '/project' })).toThrow('Unknown wait timeout target');
  });
});
