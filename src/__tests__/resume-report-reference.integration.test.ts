/**
 * resume 境界の {report:X} 参照の統合テスト（v3-r4 再現形）。
 *
 * producer 実行後に abort → resume した場合、新 run は旧 run の reports/ を
 * 継承したスナップショットを持ち、consumer（裁定ステップ）の {report:X} は
 * 新 run 内の実在ファイルへ解決される。継承が無い（レポート欠落）場合は
 * エージェント起動前（runAgent 呼び出しゼロ）に明確なエラーで落ちる。
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
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import {
  makeResponse,
  makeStep,
  makeRule,
  mockRunAgentSequence,
  mockRuleEvaluationSequence,
  createTestTmpDir,
  applyDefaultMocks,
} from './engine-test-helpers.js';

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

  it('fails with a clear error and zero agent calls when the report was not inherited', async () => {
    // 継承なし: 新 run の reports/ は空（createTestTmpDir が作成済み）。
    const engine = new WorkflowEngine(makeArbitrateConfig(), tmpDir, 'resume the arbitration', {
      projectCwd: tmpDir,
      reportDirName: 'test-report-dir',
    });

    await expect(engine.run()).rejects.toThrow(
      /Report reference "ai-antipattern-review-1st\.md" is unavailable for step "ai-antipattern-no-fix"/,
    );
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('mentions the resume source when a manifest exists but lacks the report', async () => {
    // 空の source（レポートなし）から継承した場合、manifest は存在するが
    // 対象レポートは含まれない — エラーに resume 元を明示する。
    const sourcePaths = buildRunPaths(tmpDir, 'aborted-empty');
    mkdirSync(sourcePaths.runRootAbs, { recursive: true });
    writeFileSync(join(sourcePaths.runRootAbs, 'meta.json'), '{}');
    rmSync(buildRunPaths(tmpDir, 'test-report-dir').reportsAbs, { recursive: true, force: true });
    inheritResumeReportSnapshot({ cwd: tmpDir, sourceRunSlug: 'aborted-empty', targetRunSlug: 'test-report-dir' });

    const engine = new WorkflowEngine(makeArbitrateConfig(), tmpDir, 'resume the arbitration', {
      projectCwd: tmpDir,
      reportDirName: 'test-report-dir',
    });

    await expect(engine.run()).rejects.toThrow(/Resumed from "aborted-empty"/);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });
});
