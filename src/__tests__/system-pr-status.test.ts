import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSystemStepServices } from '../infra/workflow/system/DefaultSystemStepServices.js';
import type { WorkflowEffect, WorkflowSystemInput } from '../core/models/types.js';
import type { PrCiFailure } from '../core/workflow/system/pr-ci.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';

let failFirstEvidenceWrite = false;
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, writeFile: async (...args: Parameters<typeof original.writeFile>) => {
    if (failFirstEvidenceWrite && typeof args[0] === 'string' && args[0].includes('job-')) {
      failFirstEvidenceWrite = false;
      await original.writeFile(args[0], String(args[1]).slice(0, 8), args[2]);
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
    return original.writeFile(...args);
  } };
});

describe('PR status system input target ownership', () => {
  const fetchPrStatus = vi.fn();
  const findExistingPr = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    findExistingPr.mockReturnValue({ number: 999, url: 'https://github.com/org/repo/pull/999' });
    fetchPrStatus.mockResolvedValue({ number: 123, headSha: 'a'.repeat(40), ci: { finished: false, passed: false },
      mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', reviewDecision: 'REVIEW_REQUIRED', merged: false });
  });

  function services(withContext: boolean) {
    const gitProvider = {
      checkCliStatus: () => ({ available: true as const }),
      fetchIssue: vi.fn(), createIssue: vi.fn(), closeIssue: vi.fn(), fetchPrReviewComments: vi.fn(),
      listOpenIssues: vi.fn(), listOpenPrs: vi.fn(), findExistingPr, commentOnPr: vi.fn(), closePr: vi.fn(), mergePr: vi.fn(),
      fetchPrStatus,
    };
    return createDefaultSystemStepServices({ cwd: '/clone', projectCwd: '/project', task: 'Review PR 123', gitProvider,
      ...(withContext ? { prExecutionContext: { prNumber: 123, headBranch: 'feature/pr', baseBranch: 'main',
        headSha: 'a'.repeat(40), headRepositoryUrl: 'https://github.com/author/repo.git',
        headRepositoryPushUrls: ['https://github.com/author/repo.git'] } } : {}),
    });
  }

  function resolve(service: ReturnType<typeof services>) {
    return Reflect.apply(service.resolveSystemInput, service, [{ type: 'pr_status', source: 'current_pr', as: 'status' }]);
  }

  it('実行contextのPR番号を元リポジトリで取得しbranchの別PRへ置き換えない', async () => {
    expect(await resolve(services(true))).toMatchObject({ number: 123, ci: { finished: false, passed: false } });
    expect(fetchPrStatus).toHaveBeenCalledWith(123, '/project', { signal: undefined });
    expect(findExistingPr).not.toHaveBeenCalled();
  });

  it('同じサービスで新headのCI実行中から成功まで最新状態を返す', async () => {
    const service = services(true);
    const headSha = 'b'.repeat(40);
    fetchPrStatus.mockResolvedValueOnce({ number: 123, headSha, ci: { finished: false, passed: false } })
      .mockResolvedValueOnce({ number: 123, headSha, ci: { finished: true, passed: true } });
    expect(await resolve(service)).toMatchObject({ headSha, ci: { finished: false, passed: false } });
    expect(await resolve(service)).toMatchObject({ headSha, ci: { finished: true, passed: true } });
    expect(fetchPrStatus).toHaveBeenCalledTimes(2);
  });

  it('PR実行contextがなければ暗黙のPR検索や成功値で補完しない', () => {
    expect(() => resolve(services(false))).toThrow();
    expect(fetchPrStatus).not.toHaveBeenCalled();
    expect(findExistingPr).not.toHaveBeenCalled();
  });

  it('取得例外をCI成功に変換しない', async () => {
    fetchPrStatus.mockRejectedValue(new Error('status unavailable'));
    await expect(resolve(services(true))).rejects.toThrow();
    expect(fetchPrStatus).toHaveBeenCalledWith(123, '/project', { signal: undefined });
  });

  it('取得期限とsignalをProviderへ渡す', async () => {
    const service = services(true);
    const prStatusFetchOptions = { timeoutMs: 100, signal: new AbortController().signal };
    await service.resolveSystemInput({ type: 'pr_status', source: 'current_pr', as: 'status' }, undefined, 'wait', {
      cache: new Map(), resolvedBindings: new Map(), prStatusFetchOptions,
    });
    expect(fetchPrStatus).toHaveBeenCalledWith(123, '/project', prStatusFetchOptions);
  });
});

describe('CI failure system input and rerun effect', () => {
  let runDirectory: string;
  beforeEach(() => { runDirectory = mkdtempSync(join(tmpdir(), 'takt-ci-status-')); });
  afterEach(() => { rmSync(runDirectory, { recursive: true, force: true }); });
  const headSha = 'b'.repeat(40);
  const failure = (): PrCiFailure => ({ number: 123, headSha, complete: true, checks: [
    { name: 'unit', run: { id: 10, attempt: 1, headSha, url: 'https://github.com/org/repo/actions/runs/10' },
      jobs: [{ id: 20, name: 'unit', url: 'https://github.com/org/repo/actions/runs/10/job/20',
        log: 'math.test.ts > adds\nexpected 2 to equal 3' }] },
  ], unavailable: [] });
  const input: WorkflowSystemInput = { type: 'pr_ci_failure', source: 'current_pr', as: 'failure',
    head_sha: '{context:wait_ci.status.headSha}' };
  const effect: WorkflowEffect = { type: 'rerun_ci', pr: 123,
    failure: '{context:collect_ci_failure.failure}' };

  function fixture(supported = true, runRootAbs?: string, cloneCwd = join(runDirectory, 'clone')) {
    mkdirSync(cloneCwd, { recursive: true });
    const fetchPrStatus = vi.fn(async () => ({ number: 123, headSha, ci: { finished: true, passed: false },
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', merged: false }));
    const fetchPrCiFailure = vi.fn(async () => failure());
    const rerunPrCi = vi.fn(async () => ({ success: true, failed: false, number: 123, headSha,
      runs: [{ id: 10, attempt: 1 }] }));
    const gitProvider = { checkCliStatus: vi.fn(), fetchIssue: vi.fn(), createIssue: vi.fn(), closeIssue: vi.fn(),
      fetchPrReviewComments: vi.fn(), listOpenIssues: vi.fn(), listOpenPrs: vi.fn(), findExistingPr: vi.fn(),
      commentOnPr: vi.fn(), closePr: vi.fn(), mergePr: vi.fn(),
      fetchPrStatus, ...(supported ? { fetchPrCiFailure, rerunPrCi } : {}),
    };
    const service = createDefaultSystemStepServices({ cwd: cloneCwd, projectCwd: '/project', task: 'Review PR', gitProvider,
      runPaths: { ...buildRunPaths(runDirectory, 'run'),
        ...(runRootAbs === undefined ? {} : { runRootAbs }) },
      prExecutionContext: { prNumber: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha: 'a'.repeat(40),
        headRepositoryUrl: '/remote', headRepositoryPushUrls: ['/remote'] },
    });
    const config = normalizeWorkflowConfig({ name: 'ci-recovery', initial_step: 'wait_ci', steps: [
      { name: 'wait_ci', mode: 'system', rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
    ] }, '/project');
    const state = createInitialState(config, { provider: 'mock', projectCwd: '/project' });
    state.systemContexts.set('wait_ci', { status: { number: 123, headSha, ci: { finished: true, passed: false } } });
    state.systemContexts.set('collect_ci_failure', { failure: failure() });
    state.structuredOutputs.set('investigate_ci', { verdict: 'external', summary: 'Runner outage confirmed' });
    return { service, state, fetchPrStatus, fetchPrCiFailure, rerunPrCi };
  }

  it('再実行前は通常pollingを保ち実行後は保存したPR・HEAD・旧attemptを状態取得へ渡す', async () => {
    const h = fixture();
    const statusInput: WorkflowSystemInput = { type: 'pr_status', source: 'current_pr', as: 'status',
      rerun_from: '{effect:rerun_ci.rerun_ci.rerun}' };
    expect(await h.service.resolveSystemInput(statusInput, h.state)).toMatchObject({ rerunHeadChanged: false, rerunHeadChangeReason: '' });
    expect(h.fetchPrStatus).toHaveBeenLastCalledWith(123, '/project', { signal: undefined });
    const rerun = { number: 123, headSha, runs: [{ id: 10, attempt: 1 }] };
    h.state.effectResults.set('rerun_ci', { rerun_ci: { success: true, rerun } });
    await h.service.resolveSystemInput(statusInput, h.state);
    expect(h.fetchPrStatus).toHaveBeenLastCalledWith(123, '/project', { signal: undefined, rerun });
  });

  it('再実行が失敗して結果にrerunがない場合も現在のPR状態を取得する', async () => {
    const h = fixture();
    h.state.effectResults.set('rerun_ci', { rerun_ci: { success: false, failed: true, headChanged: true } });
    const statusInput: WorkflowSystemInput = { type: 'pr_status', source: 'current_pr', as: 'status',
      rerun_from: '{effect:rerun_ci.rerun_ci.rerun}' };

    expect(await h.service.resolveSystemInput(statusInput, h.state)).toMatchObject({ number: 123, headSha });
    expect(h.fetchPrStatus).toHaveBeenCalledWith(123, '/project', { signal: undefined });
  });

  it('停止コメント用の参照情報にログ全文を複製せず再実行エラーは調査へ渡す', async () => {
    const h = fixture();
    h.state.stepIterations.set('rerun_ci', 1);
    h.state.effectResults.set('rerun_ci', { rerun_ci: { success: false, error: 'HTTP 403: rerun denied' } });
    const result = await h.service.resolveSystemInput(input, h.state);
    expect(result).toMatchObject({ checks: failure().checks, rerunCount: 1, recoveryError: 'HTTP 403: rerun denied' });
    const details = JSON.parse((result as { details: string }).details);
    expect(details).toMatchObject({ checks: [{ name: 'unit', jobs: [{ id: 20, url: expect.any(String) }] }],
      recoveryError: 'HTTP 403: rerun denied' });
    expect(Object.hasOwn(details.checks[0].jobs[0], 'log')).toBe(false);
  });

  it('保存した索引とjobログを再取得後も同じrunから参照できる', async () => {
    const h = fixture();
    const first = await h.service.resolveSystemInput(input, h.state) as { promptEvidence: string };
    const indexPath = /^Evidence index: (.+)$/m.exec(first.promptEvidence)?.[1];
    expect(indexPath).toBeDefined();
    const index = JSON.parse(readFileSync(indexPath!, 'utf8')) as {
      checks: Array<{ jobs: Array<{ logPath: string }> }>;
    };
    expect(readFileSync(index.checks[0]!.jobs[0]!.logPath, 'utf8')).toContain('math.test.ts > adds');
    const restored = JSON.parse(JSON.stringify(first)) as { promptEvidence: string };
    expect(readFileSync(/^Evidence index: (.+)$/m.exec(restored.promptEvidence)![1]!, 'utf8')).toBe(
      readFileSync(indexPath!, 'utf8'));

    const resumed = await fixture().service.resolveSystemInput(input, h.state) as { promptEvidence: string };
    expect(/^Evidence index: (.+)$/m.exec(resumed.promptEvidence)?.[1]).toBe(indexPath);
    expect(readdirSync(join(runDirectory, '.takt', 'runs', 'run', 'ci-evidence'))
      .filter((name) => name.endsWith('.log'))).toHaveLength(1);
  });

  it('別Gitリポジトリの原本とnested workspaceの表示viewをgit add -Aから保護する', async () => {
    const projectRoot = join(runDirectory, 'project');
    const cloneRoot = join(runDirectory, 'clone');
    mkdirSync(projectRoot);
    mkdirSync(cloneRoot);
    for (const root of [projectRoot, cloneRoot]) execFileSync('git', ['init', '-q'], { cwd: root });
    const runRootAbs = join(projectRoot, '.takt', 'runs', 'run');
    const cloneCwd = join(cloneRoot, 'nested [draft]');
    const h = fixture(true, runRootAbs, cloneCwd);

    const result = await h.service.resolveSystemInput(input, h.state) as { complete: boolean; promptEvidence: string };
    expect(result.complete).toBe(true);
    const canonicalDirectory = join(runRootAbs, 'ci-evidence');
    const viewDirectory = join(cloneCwd, '.takt', 'runs', 'run', 'ci-evidence');
    for (const directory of [canonicalDirectory, viewDirectory]) {
      expect(readdirSync(directory).filter((name) => name.endsWith('.json') || name.endsWith('.log'))).toHaveLength(2);
    }
    expect(result.promptEvidence).toContain(viewDirectory);
    for (const [root, directory] of [[projectRoot, canonicalDirectory], [cloneRoot, viewDirectory]] as const) {
      execFileSync('git', ['add', '-A'], { cwd: root });
      const staged = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], { cwd: root, encoding: 'utf8' })
        .split('\0').filter(Boolean);
      const evidencePrefix = `${relative(root, directory).split(sep).join('/')}/`;
      expect(staged.filter((file) => file.startsWith(evidencePrefix))).toEqual([]);
    }
  });

  it.each(['canonical', 'view'] as const)('%sのGit ignoreを拒否されたら両方の保存先に証拠本文を残さない', async (rejected) => {
    const projectRoot = join(runDirectory, 'project');
    const cloneRoot = join(runDirectory, 'clone');
    mkdirSync(projectRoot);
    mkdirSync(cloneRoot);
    for (const root of [projectRoot, cloneRoot]) execFileSync('git', ['init', '-q'], { cwd: root });
    const runRootAbs = join(projectRoot, '.takt', 'runs', 'run');
    const rejectedRoot = rejected === 'canonical' ? projectRoot : cloneRoot;
    writeFileSync(join(rejectedRoot, '.gitignore'), [
      '!/.takt/', '!/.takt/runs/', '!/.takt/runs/run/', '!/.takt/runs/run/ci-evidence/', '',
    ].join('\n'));
    const h = fixture(true, runRootAbs);

    const result = await h.service.resolveSystemInput(input, h.state);
    expect(result).toMatchObject({ complete: false,
      unavailable: expect.arrayContaining([expect.objectContaining({ name: 'CI evidence storage' })]) });
    const canonicalDirectory = join(runRootAbs, 'ci-evidence');
    const viewDirectory = join(cloneRoot, '.takt', 'runs', 'run', 'ci-evidence');
    for (const directory of [canonicalDirectory, viewDirectory]) {
      expect(readdirSync(directory)).toEqual([]);
    }
  });

  it('jobログの書込が途中で失敗しても不完全な最終ファイルを公開せず同じrunで再試行できる', async () => {
    const h = fixture();
    failFirstEvidenceWrite = true;
    try {
      const first = await h.service.resolveSystemInput(input, h.state);
      expect(first).toMatchObject({ complete: false,
        unavailable: expect.arrayContaining([expect.objectContaining({ name: 'CI evidence storage' })]) });
      const canonicalDirectory = join(runDirectory, '.takt', 'runs', 'run', 'ci-evidence');
      expect(readdirSync(canonicalDirectory)).toEqual([]);
    } finally {
      failFirstEvidenceWrite = false;
    }
    const resumed = await h.service.resolveSystemInput(input, h.state) as { complete: boolean; promptEvidence: string };
    expect(resumed.complete).toBe(true);
    const manifestPath = /^Evidence index: (.+)$/m.exec(resumed.promptEvidence)![1]!;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      checks: Array<{ jobs: Array<{ logPath: string }> }>;
    };
    expect(readFileSync(manifest.checks[0]!.jobs[0]!.logPath, 'utf8')).toBe(failure().checks[0]!.jobs[0]!.log);
  });

  it('索引を保存できなければ不完全な証拠として再実行を拒否する', async () => {
    const blocked = join(runDirectory, 'blocked');
    writeFileSync(blocked, 'file');
    const h = fixture(true, blocked);
    const result = await h.service.resolveSystemInput(input, h.state);
    expect(result).toMatchObject({ complete: false,
      unavailable: expect.arrayContaining([expect.objectContaining({ name: 'CI evidence storage' })]) });
    h.state.systemContexts.set('collect_ci_failure', { failure: result });
    expect(await h.service.executeEffect(effect, { type: 'rerun_ci', pr: 123, failure: result }, h.state))
      .toMatchObject({ success: false });
    expect(h.rerunPrCi).not.toHaveBeenCalled();
  });

  it('clone側の表示viewを作れなければ原本への保存前に再実行を拒否する', async () => {
    const h = fixture();
    writeFileSync(join(runDirectory, 'clone', '.takt'), 'blocked');
    const result = await h.service.resolveSystemInput(input, h.state);
    expect(result).toMatchObject({ complete: false,
      unavailable: expect.arrayContaining([expect.objectContaining({ name: 'CI evidence storage' })]) });
    expect(readdirSync(join(runDirectory, '.takt', 'runs', 'run', 'ci-evidence'))
      .filter((name) => name.endsWith('.log'))).toHaveLength(0);
    h.state.systemContexts.set('collect_ci_failure', { failure: result });
    expect(await h.service.executeEffect(effect, { type: 'rerun_ci', pr: 123, failure: result }, h.state))
      .toMatchObject({ success: false });
    expect(h.rerunPrCi).not.toHaveBeenCalled();
  });

  it('clone側の既存logがsymlinkなら外部の証拠を参照せず不完全とする', async () => {
    const h = fixture();
    const first = await h.service.resolveSystemInput(input, h.state) as { promptEvidence: string };
    const indexPath = /^Evidence index: (.+)$/m.exec(first.promptEvidence)![1]!;
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
      checks: Array<{ jobs: Array<{ logPath: string }> }>;
    };
    const viewLog = index.checks[0]!.jobs[0]!.logPath;
    const canonicalDirectory = join(runDirectory, '.takt', 'runs', 'run', 'ci-evidence');
    const canonicalLog = join(canonicalDirectory,
      readdirSync(canonicalDirectory).find((name) => name.endsWith('.log'))!);
    unlinkSync(viewLog);
    symlinkSync(canonicalLog, viewLog, 'file');

    const result = await h.service.resolveSystemInput(input, h.state);
    expect(result).toMatchObject({ complete: false,
      unavailable: expect.arrayContaining([expect.objectContaining({ name: 'CI evidence storage' })]) });
  });

  it('取得した失敗jobにログが欠ける場合は索引に理由を残しcompleteをfalseにする', async () => {
    const h = fixture();
    h.fetchPrCiFailure.mockResolvedValue({ ...failure(), checks: [{ ...failure().checks[0]!,
      jobs: [{ id: 20, name: 'unit', url: 'https://github.com/org/repo/actions/runs/10/job/20', log: '' }] }] });
    const result = await h.service.resolveSystemInput(input, h.state) as {
      complete: boolean; promptEvidence: string;
    };
    expect(result.complete).toBe(false);
    const indexPath = /^Evidence index: (.+)$/m.exec(result.promptEvidence)?.[1];
    const index = JSON.parse(readFileSync(indexPath!, 'utf8')) as {
      unavailable: Array<{ reason: string }>; checks: Array<{ jobs: Array<{ logPath: string | null }> }>;
    };
    expect(index.unavailable).toHaveLength(1);
    expect(index.checks[0]!.jobs[0]!.logPath).toBeNull();
  });

  it('jobのない複数checkを原本とclone側で同じ不足証拠として保持し再保存しても増やさない', async () => {
    const h = fixture();
    const run = failure().checks[0]!.run;
    h.fetchPrCiFailure.mockResolvedValue({ ...failure(), checks: [
      { name: 'unit', run, jobs: [] },
      { name: 'lint', run, jobs: [] },
    ] });

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await h.service.resolveSystemInput(input, h.state) as {
        complete: boolean; unavailable: Array<{ name: string; url?: string; reason: string }>;
        checks: Array<{ name: string }>; promptEvidence: string;
      };
      const viewPath = /^Evidence index: (.+)$/m.exec(result.promptEvidence)?.[1];
      expect(viewPath).toBeDefined();
      const view = JSON.parse(readFileSync(viewPath!, 'utf8')) as typeof result;
      const canonicalDirectory = join(runDirectory, '.takt', 'runs', 'run', 'ci-evidence');
      const canonicalPath = join(canonicalDirectory,
        readdirSync(canonicalDirectory).find((name) => name.endsWith('.json'))!);
      const canonical = JSON.parse(readFileSync(canonicalPath, 'utf8')) as typeof result;
      expect(result.complete).toBe(false);
      expect(result.unavailable).toEqual([
        { name: 'unit', url: run.url, reason: 'Failed check has no job evidence' },
        { name: 'lint', url: run.url, reason: 'Failed check has no job evidence' },
      ]);
      expect(canonical.unavailable).toEqual(result.unavailable);
      expect(view.unavailable).toEqual(result.unavailable);
      expect(view.checks).toHaveLength(2);
      h.state.systemContexts.set('collect_ci_failure', { failure: result });
      expect(await h.service.executeEffect(effect, { type: 'rerun_ci', pr: 123, failure: result }, h.state))
        .toMatchObject({ success: false });
      expect(h.rerunPrCi).not.toHaveBeenCalled();
    }
  });

  it('同じjob URLの取得失敗理由をcheckごとに原本とclone側へ一度だけ保存する', async () => {
    const h = fixture();
    const original = failure();
    const run = original.checks[0]!.run;
    const { log: _log, ...job } = original.checks[0]!.jobs[0]!;
    const unavailable = [
      { name: 'unit', url: job.url, reason: 'HTTP 403: cannot read log' },
      { name: 'lint', url: job.url, reason: 'HTTP 404: log unavailable' },
    ];
    h.fetchPrCiFailure.mockResolvedValue({ ...original, complete: false, checks: [
      { name: 'unit', run, jobs: [job] },
      { name: 'lint', run, jobs: [job] },
    ], unavailable });

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await h.service.resolveSystemInput(input, h.state) as {
        complete: boolean; unavailable: typeof unavailable; promptEvidence: string;
      };
      const viewPath = /^Evidence index: (.+)$/m.exec(result.promptEvidence)?.[1];
      expect(viewPath).toBeDefined();
      const view = JSON.parse(readFileSync(viewPath!, 'utf8')) as {
        unavailable: typeof unavailable; checks: Array<{ jobs: Array<{ logPath: string | null }> }>;
      };
      const canonicalDirectory = join(runDirectory, '.takt', 'runs', 'run', 'ci-evidence');
      const manifests = readdirSync(canonicalDirectory).filter((name) => name.endsWith('.json'));
      expect(manifests).toHaveLength(1);
      const canonical = JSON.parse(readFileSync(join(canonicalDirectory, manifests[0]!), 'utf8')) as typeof view;
      expect(result.complete).toBe(false);
      expect(result.unavailable).toEqual(unavailable);
      expect(canonical.unavailable).toEqual(unavailable);
      expect(view.unavailable).toEqual(unavailable);
      expect(view.checks).toHaveLength(2);
      expect(view.checks.flatMap(({ jobs }) => jobs.map(({ logPath }) => logPath))).toEqual([null, null]);
    }
  });

  it('証拠保存前のキャンセルを証拠不足へ変換しない', async () => {
    const h = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(h.service.resolveSystemInput(input, h.state, 'collect_ci_failure', {
      cache: new Map(), resolvedBindings: new Map(), prStatusFetchOptions: { signal: controller.signal },
    })).rejects.toBe(controller.signal.reason);
    expect(readdirSync(runDirectory)).toEqual(['clone']);
  });

  it('再実行後の失敗調査にも旧attemptの識別情報を渡して最新の失敗を取得する', async () => {
    const h = fixture();
    const rerun = { number: 123, headSha, runs: [{ id: 10, attempt: 1 }] };
    h.state.effectResults.set('rerun_ci', { rerun_ci: { success: true, rerun } });
    await h.service.resolveSystemInput(input, h.state);
    expect(h.fetchPrCiFailure).toHaveBeenCalledWith(123, headSha, '/project', { signal: undefined, rerun });
  });

  it('Cacciaが新HEADを返した後は古い再実行情報をpollingと失敗証拠へ渡さず使用済み予算は保持する', async () => {
    const h = fixture();
    const statusInput: WorkflowSystemInput = { type: 'pr_status', source: 'current_pr', as: 'status',
      rerun_from: '{effect:rerun_ci.rerun_ci.rerun}' };
    const rerun = { number: 123, headSha, runs: [{ id: 10, attempt: 1 }] };
    h.state.effectResults.set('caccia', { caccia: { success: true, headSha } });
    h.state.effectResults.set('rerun_ci', { rerun_ci: { success: true, rerun } });
    await h.service.resolveSystemInput(statusInput, h.state);
    expect(h.fetchPrStatus).toHaveBeenLastCalledWith(123, '/project', { signal: undefined, rerun });

    const newHead = 'c'.repeat(40);
    h.state.effectResults.set('caccia', { caccia: { success: true, headSha: newHead } });
    h.state.stepIterations.set('push_ci_fix', 2);
    h.fetchPrStatus.mockResolvedValue({ number: 123, headSha: newHead, ci: { finished: true, passed: false },
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', merged: false });
    const latestFailure = { ...failure(), headSha: newHead,
      checks: [{ ...failure().checks[0]!, run: { ...failure().checks[0]!.run, headSha: newHead, id: 11 } }] };
    h.fetchPrCiFailure.mockResolvedValue(latestFailure);
    await h.service.resolveSystemInput(statusInput, h.state);
    expect(h.fetchPrStatus).toHaveBeenLastCalledWith(123, '/project', { signal: undefined });
    h.state.systemContexts.set('wait_ci', { status: { headSha: newHead, ci: { finished: true, passed: false } } });
    const latestInput: WorkflowSystemInput = { ...input, head_sha: '{effect:caccia.caccia.headSha}' };
    expect(await h.service.resolveSystemInput(latestInput, h.state)).toMatchObject({ headSha: newHead,
      checks: latestFailure.checks, fixRounds: 2, rerunCount: 1 });
    expect(h.fetchPrCiFailure).toHaveBeenLastCalledWith(123, newHead, '/project', { signal: undefined });
    expect(await h.service.executeEffect(effect, { type: 'rerun_ci', pr: 123, failure: latestFailure }, h.state))
      .toMatchObject({ success: false });
    expect(h.rerunPrCi).not.toHaveBeenCalled();
  });

  it('別名ステップの再実行結果も回数とエラーに反映する', async () => {
    const h = fixture();
    h.state.effectResults.set('retry_ci', { rerun_ci: { success: false, error: 'HTTP 403: rerun denied' } });
    expect(await h.service.resolveSystemInput(input, h.state)).toMatchObject({
      rerunCount: 1, recoveryError: 'HTTP 403: rerun denied',
    });
  });

  it('初期contextのHEADを使わず失敗した最新HEADと対象PRをProviderへ渡す', async () => {
    const h = fixture();
    const result = await h.service.resolveSystemInput(input, h.state, 'collect_ci_failure');
    expect(result).toMatchObject(failure());
    expect(h.fetchPrCiFailure).toHaveBeenCalledWith(123, headSha, '/project', expect.anything());
  });

  it('初回pushとCacciaを修正予算に数えずHEAD更新後も回復pushの2周を保持する', async () => {
    const h = fixture();
    h.state.stepIterations.set('push', 1);
    h.state.stepIterations.set('caccia', 3);
    h.state.stepIterations.set('push_ci_fix', 2);
    expect(await h.service.resolveSystemInput(input, h.state, 'collect_ci_failure'))
      .toMatchObject({ fixRounds: 2, rerunCount: 0 });
  });

  it('未対応Providerを具体的な証拠不足として返す', async () => {
    const h = fixture(false);
    expect(await h.service.resolveSystemInput(input, h.state, 'collect_ci_failure'))
      .toMatchObject({ complete: false, unavailable: expect.arrayContaining([expect.objectContaining({ reason: expect.any(String) })]) });
  });

  it('外部要因判断なら修正2周後も失敗runの再実行を受け付ける', async () => {
    const h = fixture();
    h.state.stepIterations.set('push_ci_fix', 2);
    h.state.stepIterations.set('rerun_ci', 1);
    expect(await h.service.executeEffect(effect, { type: 'rerun_ci', pr: 123, failure: failure() }, h.state))
      .toMatchObject({ success: true, rerun: { number: 123, headSha, runs: [{ id: 10, attempt: 1 }] } });
    expect(h.rerunPrCi).toHaveBeenCalledOnce();
  });

  it('別名ステップで再実行済みなら新しいattemptの証拠でも二度目を拒否する', async () => {
    const h = fixture();
    h.state.currentStep = 'retry_ci_again';
    h.state.stepIterations.set('retry_ci_again', 1);
    h.state.effectResults.set('retry_ci', { rerun_ci: { success: true,
      rerun: { number: 123, headSha, runs: [{ id: 10, attempt: 1 }] } } });
    const latestFailure = failure();
    latestFailure.checks[0]!.run.attempt = 2;
    expect(await h.service.executeEffect(effect, { type: 'rerun_ci', pr: 123, failure: latestFailure }, h.state))
      .toMatchObject({ success: false, error: 'CI rerun budget is exhausted' });
    expect(h.rerunPrCi).not.toHaveBeenCalled();
    expect(h.fetchPrStatus).not.toHaveBeenCalled();
  });

  it('別名ステップの二周目は保存結果がなくても再実行しない', async () => {
    const h = fixture();
    h.state.currentStep = 'retry_ci';
    h.state.stepIterations.set('retry_ci', 2);
    expect(await h.service.executeEffect(effect, { type: 'rerun_ci', pr: 123, failure: failure() }, h.state))
      .toMatchObject({ success: false, error: 'CI rerun budget is exhausted' });
    expect(h.rerunPrCi).not.toHaveBeenCalled();
  });

  it('現在HEADが変わっていれば再実行前に拒否する', async () => {
    const h = fixture();
    h.fetchPrStatus.mockResolvedValueOnce({ number: 123, headSha: 'c'.repeat(40), ci: { finished: true, passed: true },
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', merged: false });
    expect(await h.service.executeEffect(effect, { type: 'rerun_ci', pr: 123, failure: failure() }, h.state))
      .toMatchObject({ success: false, headChanged: true });
    expect(h.rerunPrCi).not.toHaveBeenCalled();
    expect(h.fetchPrStatus).toHaveBeenCalledWith(123, '/project', { signal: undefined });
  });

  it('現在HEADの取得失敗を一致扱いにせず再実行を拒否する', async () => {
    const h = fixture();
    h.fetchPrStatus.mockRejectedValueOnce(new Error('HTTP 403'));
    expect(await h.service.executeEffect(effect, { type: 'rerun_ci', pr: 123, failure: failure() }, h.state))
      .toMatchObject({ success: false, error: 'HTTP 403' });
    expect(h.rerunPrCi).not.toHaveBeenCalled();
  });

  it.each(['defect', 'insufficient_evidence'])('判断が%sなら再実行を拒否する', async (verdict) => {
    const h = fixture();
    h.state.structuredOutputs.set('investigate_ci', { verdict, summary: 'Not an external outage' });
    expect(await h.service.executeEffect(effect, { type: 'rerun_ci', pr: 123, failure: failure() }, h.state))
      .toMatchObject({ success: false });
    expect(h.rerunPrCi).not.toHaveBeenCalled();
  });

  it.each(['wrong-pr', 'incomplete-evidence', 'already-rerun', 'partial-rerun'])('%sではCI再実行を開始しない', async (condition) => {
    const h = fixture();
    const evidence = failure();
    if (condition === 'incomplete-evidence') evidence.complete = false;
    if (condition === 'already-rerun' || condition === 'partial-rerun') {
      h.state.stepIterations.set('rerun_ci', 2);
      h.state.effectResults.set('rerun_ci', { rerun_ci: { success: condition === 'already-rerun',
        rerun: { number: 123, headSha, runs: [{ id: 10, attempt: 1 }] } } });
    }
    expect(await h.service.executeEffect(effect, { type: 'rerun_ci', pr: condition === 'wrong-pr' ? 999 : 123,
      failure: evidence }, h.state)).toMatchObject({ success: false });
    expect(h.rerunPrCi).not.toHaveBeenCalled();
  });
});
