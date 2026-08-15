/**
 * resume 境界の {report:X} 参照の統合テスト（v3-r4 再現形）。
 *
 * producer 実行後に abort → resume した場合、新 run は旧 run の reports/ を
 * 継承したスナップショットを持ち、consumer（裁定ステップ）の {report:X} は
 * 新 run 内の実在ファイルへ解決される。継承が無い（レポート欠落）場合も
 * 平易な欠落文を agent に渡して run を続ける。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: '', method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import { runAgent } from '../agents/runner.js';
import { inheritResumeReportSnapshot } from '../core/workflow/run/resume-report-snapshot.js';
import { buildResumeReportSnapshotConsumerEntry } from '../core/workflow/run/resume-report-reference-snapshot.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';
import { buildWorkflowCallInvocationIdentity } from '../core/workflow/workflow-call-invocation-index.js';
import {
  makeResponse,
  makeStep,
  makeRule,
  mockRunAgentSequence,
  mockRuleEvaluationSequence,
  createTestTmpDir,
  applyDefaultMocks,
} from './engine-test-helpers.js';
import { makeNormalizedWorkflowCallStep } from './helpers/normalized-workflow-call-step.js';

const CONSUMER_INSTRUCTION = 'Arbitrate using {report:ai-antipattern-review-1st.md}';

function makeArbitrateConfig(): WorkflowConfig {
  return {
    name: 'resume-arbitrate',
    maxSteps: 10,
    initialStep: 'ai-antipattern-no-fix',
    steps: [
      makeStep('ai-antipattern-no-fix', {
        instruction: CONSUMER_INSTRUCTION,
        rules: [
          makeRule('reviewer right', 'COMPLETE'),
          makeRule('coder right', 'COMPLETE'),
        ],
      }),
    ],
  };
}

function makeFinalGateWorkflows(): { parent: WorkflowConfig; child: WorkflowConfig } {
  const child: WorkflowConfig = {
    name: 'review-gate',
    subworkflow: { callable: true },
    maxSteps: 2,
    initialStep: 'final-gate',
    steps: [makeStep('final-gate', {
      instruction: 'Resolve final gate with {report:review-resolution.md}',
      rules: [makeRule('approved', 'COMPLETE')],
    })],
  };
  const parent: WorkflowConfig = {
    name: 'experimental',
    maxSteps: 2,
    initialStep: 'review',
    steps: [makeNormalizedWorkflowCallStep({
      name: 'review',
      call: 'review-gate',
      rules: [makeRule('COMPLETE', 'COMPLETE')],
    })],
  };
  return { parent, child };
}

function makeFinalGateResumePoint(
  parent: WorkflowConfig,
  child: WorkflowConfig,
  occurrence: number,
  namespace: string,
) {
  const callEntry = buildWorkflowResumePointEntry(
    parent,
    'review',
    'workflow_call',
    occurrence,
    undefined,
    occurrence,
  );
  return {
    callEntry,
    resumePoint: {
      version: 2 as const,
      stack: [
        callEntry,
        buildWorkflowResumePointEntry(child, 'final-gate', 'agent', 1),
      ],
      iteration: occurrence,
      elapsed_ms: 0,
      workflow_call_invocations: {
        [buildWorkflowCallInvocationIdentity(parent.name, 'review', [])]: {
          call_instance: occurrence,
          report_namespace_segment: namespace,
        },
      },
      workflow_step_participations: {},
    },
  };
}

describe('resume boundary: {report:X} references across runs', () => {
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

  function seedAbortedSourceRun(slug: string): void {
    const paths = buildRunPaths(tmpDir, slug);
    mkdirSync(paths.reportsAbs, { recursive: true });
    writeFileSync(join(paths.runRootAbs, 'meta.json'), JSON.stringify({ status: 'aborted' }));
    // producer（ai-antipattern-review-1st）が abort 前に書いたレポート。
    writeFileSync(join(paths.reportsAbs, 'ai-antipattern-review-1st.md'), 'REJECT: findings...');
  }

  it('resolves the consumer reference to the inherited snapshot in the new run (v3-r4 shape)', async () => {
    seedAbortedSourceRun('aborted-run');
    inheritResumeReportSnapshot({ cwd: tmpDir, sourceRunSlug: 'aborted-run', targetRunSlug: 'test-report-dir' });

    mockRunAgentSequence([makeResponse({ persona: 'ai-antipattern-no-fix', content: 'reviewer right' })]);
    mockRuleEvaluationSequence([{ index: 0, method: 'auto_select' }]);

    const engine = new WorkflowEngine(makeArbitrateConfig(), tmpDir, 'resume the arbitration', {
      projectCwd: tmpDir,
      reportDirName: 'test-report-dir',
    });
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    const instruction = vi.mocked(runAgent).mock.calls[0]?.[1] as string;
    const inheritedPath = join(tmpDir, '.takt/runs/test-report-dir/reports/ai-antipattern-review-1st.md');
    expect(instruction).toContain('REJECT: findings...');
    expect(instruction).not.toContain('{report:ai-antipattern-review-1st.md}');
    expect(readFileSync(inheritedPath, 'utf-8')).toBe('REJECT: findings...');
  });

  it('continues with a plain missing-report sentence when the report was not inherited', async () => {
    // 継承なし: 新 run の reports/ は空（createTestTmpDir が作成済み）。
    mockRunAgentSequence([makeResponse({ persona: 'ai-antipattern-no-fix', content: 'reviewer right' })]);
    mockRuleEvaluationSequence([{ index: 0, method: 'auto_select' }]);
    const engine = new WorkflowEngine(makeArbitrateConfig(), tmpDir, 'resume the arbitration', {
      projectCwd: tmpDir,
      reportDirName: 'test-report-dir',
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toContain(
      '（参照先の報告 ai-antipattern-review-1st.md はこの run に存在しない）',
    );
  });

  it('continues with the same missing-report sentence when a snapshot lacks the report', async () => {
    // 空の source（レポートなし）から継承した場合、manifest は存在するが
    // 対象レポートは含まれない。
    const sourcePaths = buildRunPaths(tmpDir, 'aborted-empty');
    mkdirSync(sourcePaths.runRootAbs, { recursive: true });
    writeFileSync(join(sourcePaths.runRootAbs, 'meta.json'), '{}');
    rmSync(buildRunPaths(tmpDir, 'test-report-dir').reportsAbs, { recursive: true, force: true });
    inheritResumeReportSnapshot({ cwd: tmpDir, sourceRunSlug: 'aborted-empty', targetRunSlug: 'test-report-dir' });
    mockRunAgentSequence([makeResponse({ persona: 'ai-antipattern-no-fix', content: 'reviewer right' })]);
    mockRuleEvaluationSequence([{ index: 0, method: 'auto_select' }]);

    const engine = new WorkflowEngine(makeArbitrateConfig(), tmpDir, 'resume the arbitration', {
      projectCwd: tmpDir,
      reportDirName: 'test-report-dir',
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toContain(
      '（参照先の報告 ai-antipattern-review-1st.md はこの run に存在しない）',
    );
  });

  it('resolves final-gate report from the source namespace snapshot after its namespace changes', async () => {
    const { parent, child } = makeFinalGateWorkflows();
    const oldNamespace = 'iteration-1--step-review--workflow-review-gate--site-old';
    const source = makeFinalGateResumePoint(parent, child, 1, oldNamespace);
    const sourceReports = buildRunPaths(tmpDir, 'final-gate-source').reportsAbs;
    mkdirSync(join(sourceReports, 'subworkflows', oldNamespace), { recursive: true });
    writeFileSync(
      join(sourceReports, 'subworkflows', oldNamespace, 'review-resolution.md'),
      'SOURCE RESOLUTION',
    );
    const consumer = buildResumeReportSnapshotConsumerEntry({
      cwd: tmpDir,
      projectCwd: tmpDir,
      sourceRunSlug: 'final-gate-source',
      workflow: parent,
      resumePoint: source.resumePoint,
      workflowCallResolver: ({ step }) => step.call === 'review-gate' ? child : null,
    });
    expect(consumer?.references).toEqual([{
      reference: 'review-resolution.md',
      path: `subworkflows/${oldNamespace}/review-resolution.md`,
    }]);
    rmSync(buildRunPaths(tmpDir, 'test-report-dir').reportsAbs, { recursive: true, force: true });
    inheritResumeReportSnapshot({
      cwd: tmpDir,
      sourceRunSlug: 'final-gate-source',
      targetRunSlug: 'test-report-dir',
      resumeReportConsumers: consumer === undefined ? [] : [consumer],
    });
    mockRunAgentSequence([makeResponse({ persona: 'final-gate', content: 'approved' })]);
    mockRuleEvaluationSequence([{ index: 0, method: 'auto_select' }]);
    const newCall = buildWorkflowResumePointEntry(parent, 'review', 'workflow_call', 2, undefined, 2);
    const engine = new WorkflowEngine(child, tmpDir, 'resume final gate', {
      projectCwd: tmpDir,
      reportDirName: 'test-report-dir',
      runPathNamespace: ['subworkflows', 'iteration-2--step-review--workflow-review-gate--site-new'],
      resumeStackPrefix: [newCall],
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toContain('SOURCE RESOLUTION');
  });

  it('propagates the source mapping through a zero-iteration intermediate requeue', async () => {
    const { parent, child } = makeFinalGateWorkflows();
    const originalNamespace = 'iteration-1--step-review--workflow-review-gate--site-original';
    const original = makeFinalGateResumePoint(parent, child, 1, originalNamespace);
    const originalReports = buildRunPaths(tmpDir, 'chain-original').reportsAbs;
    mkdirSync(join(originalReports, 'subworkflows', originalNamespace), { recursive: true });
    writeFileSync(
      join(originalReports, 'subworkflows', originalNamespace, 'review-resolution.md'),
      'CHAINED RESOLUTION',
    );
    const firstConsumer = buildResumeReportSnapshotConsumerEntry({
      cwd: tmpDir,
      projectCwd: tmpDir,
      sourceRunSlug: 'chain-original',
      workflow: parent,
      resumePoint: original.resumePoint,
      workflowCallResolver: ({ step }) => step.call === 'review-gate' ? child : null,
    })!;
    inheritResumeReportSnapshot({
      cwd: tmpDir,
      sourceRunSlug: 'chain-original',
      targetRunSlug: 'chain-failed-zero-iteration',
      resumeReportConsumers: [firstConsumer],
    });
    const intermediate = makeFinalGateResumePoint(
      parent,
      child,
      2,
      'iteration-2--step-review--workflow-review-gate--site-unused',
    );
    const propagatedConsumer = buildResumeReportSnapshotConsumerEntry({
      cwd: tmpDir,
      projectCwd: tmpDir,
      sourceRunSlug: 'chain-failed-zero-iteration',
      workflow: parent,
      resumePoint: intermediate.resumePoint,
      workflowCallResolver: ({ step }) => step.call === 'review-gate' ? child : null,
    })!;
    rmSync(buildRunPaths(tmpDir, 'test-report-dir').reportsAbs, { recursive: true, force: true });
    inheritResumeReportSnapshot({
      cwd: tmpDir,
      sourceRunSlug: 'chain-failed-zero-iteration',
      targetRunSlug: 'test-report-dir',
      resumeReportConsumers: [propagatedConsumer],
    });
    mockRunAgentSequence([makeResponse({ persona: 'final-gate', content: 'approved' })]);
    mockRuleEvaluationSequence([{ index: 0, method: 'auto_select' }]);
    const currentCall = buildWorkflowResumePointEntry(parent, 'review', 'workflow_call', 3, undefined, 3);
    const engine = new WorkflowEngine(child, tmpDir, 'resume final gate again', {
      projectCwd: tmpDir,
      reportDirName: 'test-report-dir',
      runPathNamespace: ['subworkflows', 'iteration-3--step-review--workflow-review-gate--site-current'],
      resumeStackPrefix: [currentCall],
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toContain('CHAINED RESOLUTION');
  });
});
