import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsi } from '../shared/utils/text.js';
import { executePrWorkflow as executeRealPrWorkflow, runLinkedMergeSafely, runMerge, resolveMergeSettings } from '../features/merge/index.js';
import type { SystemStepPrListItem } from '../core/workflow/system/system-step-services.js';

const mocks = vi.hoisted(() => ({ provider: vi.fn(), config: vi.fn(), details: vi.fn(), status: vi.fn(),
  reviewStatus: vi.fn(), clone: vi.fn(), git: vi.fn(), cloneOperations: vi.fn(), workflow: vi.fn(),
  temporaryDirectory: vi.fn(), cleanup: vi.fn() }));
vi.mock('../infra/git/index.js', () => ({ getGitProvider: mocks.provider }));
vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), resolveConfigValue: mocks.config,
}));
vi.mock('../infra/github/pr.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), fetchCodeRabbitReviewStatus: mocks.reviewStatus,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual,
    mkdtempSync: (...args: Parameters<typeof actual.mkdtempSync>) => String(args[0]).includes('takt-merge-')
      ? mocks.temporaryDirectory(...args) : actual.mkdtempSync(...args),
    rmSync: (...args: Parameters<typeof actual.rmSync>) => String(args[0]).startsWith('/temporary-merge')
      ? mocks.cleanup(...args) : actual.rmSync(...args),
  };
});
vi.mock('../infra/task/clone-exec.js', () => ({
  cloneAndIsolateAbortable: mocks.clone, runGitCommandAbortable: mocks.git,
}));
vi.mock('../infra/task/git-environment.js', () => ({ buildSafeGitEnvironment: vi.fn(async () => ({})) }));
vi.mock('../infra/workflow/system/pr-clone-git.js', () => ({ createPrCloneGitOperations: mocks.cloneOperations }));
vi.mock('../features/tasks/execute/workflowExecutionApi.js', () => ({ runWorkflowExecution: mocks.workflow }));

function pr(number: number, overrides: Partial<SystemStepPrListItem> = {}): SystemStepPrListItem {
  return { number, author: 'alice', labels: ['ready', 'automation'], base_branch: 'main',
    head_branch: `takt/${number}`, managed_by_takt: true, same_repository: true,
    draft: false, updated_at: '2026-10-05T12:00:00Z', ...overrides };
}

const listOpenPrs = vi.fn();
const executePrWorkflow = vi.fn();
const dependencies = { listOpenPrs, executePrWorkflow };

function run(options: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  return runMerge({ projectCwd: '/project', concurrency: 2,
    settings: resolveMergeSettings(config), ...options }, dependencies);
}

function processedNumbers(): number[] {
  return executePrWorkflow.mock.calls.map(([input]) => (input as { prNumber: number }).prNumber);
}

function* listedPrs(prs: SystemStepPrListItem[]): Generator<SystemStepPrListItem> {
  yield* prs;
}

describe('Merge target selection and execution', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.provider.mockReturnValue({ checkCliStatus: () => ({ available: true }),
      fetchPrDetails: mocks.details, fetchPrStatus: mocks.status });
    listOpenPrs.mockImplementation(() => listedPrs([pr(123), pr(456)]));
    executePrWorkflow.mockResolvedValue({ merged: true });
  });

  it('番号指定時は不一致条件とdraft除外を適用せず指定PRだけを実行する', async () => {
    await run({ prNumber: 123, where: { author: 'other', draft: false } },
      { where: { labels: ['absent'] } });
    expect(processedNumbers()).toEqual([123]);
    expect(listOpenPrs).not.toHaveBeenCalled();
  });

  it('条件がなければdraft・fork以外のopen PRを一巡して再スキャンしない', async () => {
    listOpenPrs.mockReturnValue(listedPrs([pr(123), pr(456, { draft: true }), pr(789, { same_repository: false })]));
    await run();
    expect(processedNumbers().sort()).toEqual([123]);
    expect(listOpenPrs).toHaveBeenCalledOnce();
    expect(listOpenPrs).toHaveBeenCalledWith('/project', { allPages: true });
  });

  it('既定のproviderへ一括取得オプションを引き継ぐ', async () => {
    mocks.provider.mockReturnValue({ listOpenPrs: listOpenPrs.mockReturnValue([]) });
    expect(await runMerge({ projectCwd: '/project', concurrency: 1, settings: resolveMergeSettings(undefined) }))
      .toEqual({ processedCount: 0, mergedCount: 0, exitCode: 0 });
    expect(listOpenPrs).toHaveBeenCalledWith('/project', { allPages: true });
  });

  it('includeDraftはdraftと非draftの両方を対象にする', async () => {
    listOpenPrs.mockReturnValue([pr(123), pr(456, { draft: true })]);
    await run({ includeDraft: true });
    expect(processedNumbers().sort()).toEqual([123, 456]);
  });

  it.each(['CLI', 'config'])('%sのincludeForks指定でforkと同一repositoryを対象にする', async (source) => {
    listOpenPrs.mockReturnValue([pr(123), pr(456, { same_repository: false })]);
    await run(source === 'CLI' ? { includeForks: true } : {}, source === 'config' ? { includeForks: true } : {});
    expect(processedNumbers()).toEqual([123, 456]);
  });

  it('same_repository=falseだけではforkの既定除外を迂回しない', async () => {
    listOpenPrs.mockReturnValue([pr(123), pr(456, { same_repository: false })]);
    await run({}, { where: { same_repository: false } });
    expect(processedNumbers()).toEqual([]);
  });

  it('CLI条件で設定のfork包含とdraft包含を置換する', async () => {
    listOpenPrs.mockReturnValue([pr(123), pr(456, { same_repository: false }), pr(789, { draft: true })]);
    await run({ where: { author: 'alice' } }, { includeForks: true, includeDraft: true });
    expect(processedNumbers()).toEqual([123]);
  });

  it('includeForksだけのCLI条件で設定条件全体を置換する', async () => {
    listOpenPrs.mockReturnValue([pr(123), pr(456, { same_repository: false })]);
    await run({ includeForks: true }, { where: { author: 'absent' } });
    expect(processedNumbers()).toEqual([123, 456]);
  });

  it('設定のdraft条件だけでは既定のdraft除外を迂回しない', async () => {
    listOpenPrs.mockReturnValue([pr(123), pr(456, { draft: true })]);
    await run({}, { where: { draft: true } });
    expect(processedNumbers()).toEqual([]);
    await run({}, { includeDraft: true, where: { draft: true } });
    expect(processedNumbers()).toEqual([456]);
  });

  it.each([
    ['author', { author: 'alice' }, { author: 'bob' }],
    ['labels', { labels: ['ready', 'automation'] }, { labels: ['ready'] }],
    ['base', { base_branch: 'main' }, { base_branch: 'release' }],
    ['head wildcard', { head_branch: 'takt/*' }, { head_branch: 'manual/fix' }],
    ['managed', { managed_by_takt: true }, { managed_by_takt: false }],
    ['repository', { same_repository: true }, { same_repository: false }],
  ])('%s条件で一致するPRだけを実行する', async (_name, where, mismatch) => {
    listOpenPrs.mockReturnValue(listedPrs([pr(123), pr(456, mismatch)]));
    await run({ where });
    expect(processedNumbers()).toEqual([123]);
  });

  it('CLI条件は設定条件全体を置換し未指定項目を混合しない', async () => {
    listOpenPrs.mockReturnValue([pr(123), pr(456, { author: 'bob', labels: ['different'] })]);
    await run({ where: { author: 'bob' } }, { where: { author: 'alice', labels: ['ready'], base_branch: 'release' } });
    expect(processedNumbers()).toEqual([456]);
  });

  it('includeDraftだけのCLI指定でも設定条件全体を置換する', async () => {
    listOpenPrs.mockReturnValue([pr(123), pr(456, { draft: true })]);
    await run({ includeDraft: true }, { where: { author: 'absent' } });
    expect(processedNumbers().sort()).toEqual([123, 456]);
  });

  it('workflowだけのCLI指定では設定条件を保持する', async () => {
    listOpenPrs.mockReturnValue([pr(123), pr(456, { author: 'bob' })]);
    await run({ workflow: 'custom-review' }, { where: { author: 'bob' }, workflow: 'configured-review' });
    expect(processedNumbers()).toEqual([456]);
    expect(executePrWorkflow.mock.calls[0]?.[0]).toMatchObject({ workflow: 'custom-review' });
  });

  it('workflowを省略した場合は設定のworkflowを使う', async () => {
    await run({ prNumber: 123 }, { workflow: 'configured-review' });
    expect(executePrWorkflow.mock.calls[0]?.[0]).toMatchObject({ workflow: 'configured-review' });
  });

  it('設定のconcurrencyまで並列に開始し一件の例外で後続PRを中止しない', async () => {
    listOpenPrs.mockReturnValue(listedPrs([pr(123), pr(456), pr(789)]));
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    executePrWorkflow.mockImplementation(({ prNumber }: { prNumber: number }) => new Promise((resolve, reject) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      releases.push(() => {
        active -= 1;
        if (prNumber === 123) reject(new Error('PR failed'));
        else resolve({ merged: true });
      });
    }));
    const running = run();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(active).toBe(2);
    releases[0]!();
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases[1]!();
    releases[2]!();
    const result = await running;
    expect(maxActive).toBe(2);
    expect(processedNumbers().sort()).toEqual([123, 456, 789]);
    expect(result).toMatchObject({ processedCount: 3, mergedCount: 2, exitCode: 1 });
  });

  it.each([
    ['全件マージ', [true, true], 2, 0],
    ['一件未マージ', [true, false], 1, 1],
    ['コメントのみでworkflow正常終了', [false, false], 0, 1],
  ] as const)('%sの実際のマージ件数と終了コードを返す', async (_name, outcomes, mergedCount, exitCode) => {
    for (const merged of outcomes) executePrWorkflow.mockResolvedValueOnce({ merged });
    expect(await run()).toMatchObject({ processedCount: 2, mergedCount, exitCode });
  });

  it.each([true, false])('3件のうちPR123のmerged=%sを集計して後続も処理する', async (merged) => {
    listOpenPrs.mockReturnValue(listedPrs([pr(123), pr(456), pr(789)]));
    executePrWorkflow.mockImplementation(async ({ prNumber }: { prNumber: number }) => ({
      merged: prNumber === 123 ? merged : true,
    }));
    expect(await run()).toEqual({ processedCount: 3, mergedCount: merged ? 3 : 2, exitCode: merged ? 0 : 1 });
    expect(processedNumbers()).toEqual([123, 456, 789]);
  });

  it('対象ゼロならworkflowを起動せず成功終了する', async () => {
    listOpenPrs.mockReturnValue([]);
    expect(await run()).toMatchObject({ processedCount: 0, mergedCount: 0, exitCode: 0 });
    expect(executePrWorkflow).not.toHaveBeenCalled();
  });

  it('既定はsquash・自動起動無効・draft除外である', () => {
    expect(resolveMergeSettings(undefined)).toMatchObject({ method: 'squash', autoStart: false, includeDraft: false,
      includeForks: false, threatCheckMaxDiffBytes: 200_000 });
  });

  it('自動起動が既定で無効ならproviderもPR workflowも起動しない', async () => {
    await runLinkedMergeSafely('/project', 'https://github.com/org/repo/pull/123');
    expect(mocks.config).toHaveBeenCalledWith('/project', 'merge');
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it('自動起動のPR URLが不正なら別PRを選定せず終了する', async () => {
    mocks.config.mockReturnValue({ autoStart: true });
    await runLinkedMergeSafely('/project', 'https://github.com/org/repo/pull/0');
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  const request = { projectCwd: '/project', prNumber: 123, workflow: 'merge-review',
    settings: resolveMergeSettings(undefined) };

  it('PR実行に必要なCLIが使えなければクローン作成前に拒否する', async () => {
    mocks.provider.mockReturnValue({ checkCliStatus: () => ({ available: false, error: 'CLI unavailable' }) });
    await expect(executeRealPrWorkflow(request)).rejects.toThrow('CLI unavailable');
    expect(mocks.details).not.toHaveBeenCalled();
  });

  it('PR状態取得に未対応のproviderを成功扱いしない', async () => {
    mocks.provider.mockReturnValue({ checkCliStatus: () => ({ available: true }) });
    await expect(executeRealPrWorkflow(request)).rejects.toThrow('does not support');
  });

  it('取得したメタデータが別PRならそのheadでworkflowを起動しない', async () => {
    mocks.details.mockResolvedValue({ number: 456 });
    await expect(executeRealPrWorkflow(request)).rejects.toThrow('different PR');
    expect(mocks.status).not.toHaveBeenCalled();
  });
});

describe('Merge CodeRabbit gate', () => {
  const headSha = 'a'.repeat(40);
  const request = { projectCwd: '/project', prNumber: 123, workflow: 'merge-review',
    settings: resolveMergeSettings(undefined) };
  let lines: string[];

  function reviewStatus(overrides: Record<string, unknown>) {
    return { headSha, hasCodeRabbitPost: true, hasCodeRabbitStatus: false,
      reviewedHeadShas: [headSha], unresolvedThreadCount: 0, ...overrides };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    lines = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    }
    mocks.provider.mockReturnValue({ checkCliStatus: () => ({ available: true }),
      fetchPrDetails: mocks.details, fetchPrStatus: mocks.status });
    mocks.details.mockImplementation(async (number: number) => ({ number, headSha,
      headBranch: `feature/${number}`, baseBranch: 'main', sameRepository: true,
      headRepositoryUrl: '/remote', headRepositoryPushUrls: ['/remote'] }));
    mocks.reviewStatus.mockResolvedValue(reviewStatus({}));
    mocks.temporaryDirectory.mockReturnValue('/temporary-merge');
    mocks.git.mockImplementation(async (_cwd: string, args: string[]) => ({
      stdout: args[0] === 'rev-parse' ? headSha : '', stderr: '', exitCode: 0,
    }));
    mocks.cloneOperations.mockResolvedValue({ headRepositoryUrl: '/remote', headRepositoryPushUrls: ['/remote'],
      baseRepositoryUrl: '/project', operations: { fetch: vi.fn(), push: vi.fn() } });
    mocks.workflow.mockResolvedValue({ success: true });
    mocks.status.mockResolvedValue({ merged: true });
  });

  afterEach(() => vi.restoreAllMocks());

  it('マージ済みheadのレビュー完了と未解決ゼロなら従来のworkflowへ進む', async () => {
    expect(await executeRealPrWorkflow(request)).toEqual({ merged: true });
    expect(mocks.workflow).toHaveBeenCalledOnce();
    expect(mocks.workflow.mock.calls[0]?.[0]).toMatchObject({ mergeMethod: 'squash',
      prExecutionContext: { prNumber: 123, headSha } });
  });

  it.each([
    ['レート制限通知だけ', { reviewedHeadShas: [],
      rateLimit: { retryAt: undefined, createdAt: 0, isCommandReply: true } }],
    ['前のheadだけレビュー済み', { reviewedHeadShas: ['previous-head'] }],
    ['pendingステータスだけ', { hasCodeRabbitPost: false, hasCodeRabbitStatus: true, reviewedHeadShas: [] }],
  ])('%sのPRは待たずに飛ばしてレビュー未完了を表示する', async (_name, status) => {
    mocks.reviewStatus.mockResolvedValue(reviewStatus(status));

    expect(await executeRealPrWorkflow(request)).toEqual({ merged: false });
    expect(mocks.reviewStatus).toHaveBeenCalledOnce();
    expect(mocks.temporaryDirectory).not.toHaveBeenCalled();
    expect(mocks.clone).not.toHaveBeenCalled();
    expect(mocks.workflow).not.toHaveBeenCalled();
    expect(stripAnsi(lines.join('\n'))).toMatch(/123/u);
    expect(stripAnsi(lines.join('\n'))).toMatch(/CodeRabbit/u);
    expect(stripAnsi(lines.join('\n'))).toMatch(/未完了|not.*(?:reviewed|complete)|review.*(?:pending|incomplete)/iu);
  });

  it('レビュー完了でも未解決のCodeRabbitスレッドがあれば件数を表示して飛ばす', async () => {
    mocks.reviewStatus.mockResolvedValue(reviewStatus({ unresolvedThreadCount: 2 }));

    expect(await executeRealPrWorkflow(request)).toEqual({ merged: false });
    expect(mocks.clone).not.toHaveBeenCalled();
    expect(mocks.workflow).not.toHaveBeenCalled();
    expect(stripAnsi(lines.join('\n'))).toMatch(/123/u);
    expect(stripAnsi(lines.join('\n'))).toMatch(/(?:未解決|unresolved).*2|2.*(?:未解決|unresolved)/iu);
  });

  it('CodeRabbit未使用ならレビュー完了を要求せず従来のworkflowへ進む', async () => {
    mocks.reviewStatus.mockResolvedValue(reviewStatus({ hasCodeRabbitPost: false,
      hasCodeRabbitStatus: false, reviewedHeadShas: [] }));

    expect(await executeRealPrWorkflow(request)).toEqual({ merged: true });
    expect(mocks.workflow).toHaveBeenCalledOnce();
  });

  it('CodeRabbit確認で飛ばしたPRの後も次のPRを実行して実際の件数を集計する', async () => {
    mocks.reviewStatus.mockImplementation(async (number: number) => reviewStatus({
      reviewedHeadShas: number === 123 ? [] : [headSha],
    }));

    expect(await runMerge({ projectCwd: '/project', concurrency: 1, settings: request.settings }, {
      listOpenPrs: () => [pr(123), pr(456)], executePrWorkflow: executeRealPrWorkflow,
    })).toEqual({ processedCount: 2, mergedCount: 1, exitCode: 1 });
    expect(mocks.workflow).toHaveBeenCalledOnce();
    expect(mocks.workflow.mock.calls[0]?.[0]).toMatchObject({ prExecutionContext: { prNumber: 456 } });
  });

  it('CodeRabbit状態の取得失敗を未使用としてworkflowへ通さない', async () => {
    mocks.reviewStatus.mockRejectedValue(new Error('GitHub lookup failed'));

    await expect(executeRealPrWorkflow(request)).rejects.toThrow('GitHub lookup failed');
    expect(mocks.clone).not.toHaveBeenCalled();
    expect(mocks.workflow).not.toHaveBeenCalled();
  });
});
