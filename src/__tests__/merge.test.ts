import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executePrWorkflow as executeRealPrWorkflow, runLinkedMergeSafely, runMerge, resolveMergeSettings } from '../features/merge/index.js';
import type { SystemStepPrListItem } from '../core/workflow/system/system-step-services.js';

const mocks = vi.hoisted(() => ({ provider: vi.fn(), config: vi.fn(), details: vi.fn(), status: vi.fn() }));
vi.mock('../infra/git/index.js', () => ({ getGitProvider: mocks.provider }));
vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), resolveConfigValue: mocks.config,
}));

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
