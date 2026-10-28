import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executePrWorkflow as executeRealPrWorkflow, runLinkedMergeSafely, runMerge, resolveMergeSettings } from '../features/merge/index.js';
import type { SystemStepPrListItem } from '../core/workflow/system/system-step-services.js';

const mocks = vi.hoisted(() => ({ provider: vi.fn(), config: vi.fn(), details: vi.fn(), status: vi.fn(), agent: vi.fn(), selectionData: vi.fn(),
  confirm: vi.fn(), confirmWithCancel: vi.fn() }));
vi.mock('../agents/agent-usecases.js', () => ({ executeAgent: mocks.agent }));
vi.mock('../shared/prompt/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/prompt/index.js')>()),
  confirm: mocks.confirm, confirmWithCancel: mocks.confirmWithCancel,
}));
vi.mock('../infra/git/index.js', () => ({ getGitProvider: mocks.provider }));
vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), resolveConfigValue: mocks.config,
}));

function pr(number: number, overrides: Partial<SystemStepPrListItem> = {}): SystemStepPrListItem {
  return { number, author: 'alice', labels: ['ready', 'automation'], base_branch: 'main',
    head_branch: `takt/${number}`, managed_by_takt: true, same_repository: true,
    draft: false, updated_at: '2026-10-05T12:00:00Z', ...overrides };
}

const listOpenPrNumbers = vi.fn();
const fetchPrListItem = vi.fn();
function setPrs(prs: SystemStepPrListItem[]): void {
  listOpenPrNumbers.mockReturnValue(prs.map((item) => item.number));
  fetchPrListItem.mockImplementation((number: number) => prs.find((item) => item.number === number));
}
const executePrWorkflow = vi.fn();
const dependencies = { listOpenPrNumbers, fetchPrListItem, executePrWorkflow };

function run(options: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  return runMerge({ projectCwd: '/project', concurrency: 2,
    settings: resolveMergeSettings(config), ...options }, dependencies);
}

function processedNumbers(): number[] {
  return executePrWorkflow.mock.calls.map(([input]) => (input as { prNumber: number }).prNumber);
}

describe('Merge target selection and execution', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.confirm.mockResolvedValue(true);
    mocks.confirmWithCancel.mockResolvedValue({ kind: 'value', value: true });
    mocks.provider.mockReturnValue({ checkCliStatus: () => ({ available: true }),
      fetchPrDetails: mocks.details, fetchPrStatus: mocks.status, fetchPrSelectionData: mocks.selectionData });
    mocks.selectionData.mockImplementation((number: number) => ({ number, title: `PR ${number}`, body: 'Description', files: ['docs/guide.md'] }));
    mocks.agent.mockResolvedValue({ status: 'done', content: '', persona: 'selector', structuredOutput: { selected: true, reason: '意図に合う' } });
    setPrs([pr(123), pr(456)]);
    executePrWorkflow.mockResolvedValue({ merged: true });
  });

  it('専用の同時処理数は未設定時2を使う', () => {
    expect(resolveMergeSettings(undefined).concurrency).toBe(2);
    expect(resolveMergeSettings({ concurrency: 5 }).concurrency).toBe(5);
  });

  it.each([2, 3, 4])('実行時並列数%sを設定値より優先して各PRのworkflowへ渡す', async (concurrency) => {
    await run({ concurrency }, { concurrency: 7 });
    expect(executePrWorkflow).toHaveBeenCalledTimes(2);
    for (const [request] of executePrWorkflow.mock.calls) {
      expect(request.settings).toMatchObject({ concurrency });
    }
  });

  it('番号指定時は不一致条件とdraft除外を適用せず指定PRだけを実行する', async () => {
    await run({ prNumber: 123, where: { author: 'other', draft: false } },
      { where: { labels: ['absent'] } });
    expect(processedNumbers()).toEqual([123]);
    expect(listOpenPrNumbers).not.toHaveBeenCalled();
    expect(fetchPrListItem).not.toHaveBeenCalled();
    expect(mocks.agent).not.toHaveBeenCalled();
    expect(mocks.selectionData).not.toHaveBeenCalled();
  });

  it('条件がなければdraft・fork以外のopen PRを一巡して再スキャンしない', async () => {
    setPrs([pr(123), pr(456, { draft: true }), pr(789, { same_repository: false })]);
    await run();
    expect(processedNumbers().sort()).toEqual([123]);
    expect(listOpenPrNumbers).toHaveBeenCalledOnce();
    expect(listOpenPrNumbers).toHaveBeenCalledWith('/project');
    expect(mocks.agent).not.toHaveBeenCalled();
    expect(mocks.selectionData).not.toHaveBeenCalled();
  });

  it('既定のproviderへ番号一覧取得を引き継ぐ', async () => {
    setPrs([]);
    mocks.provider.mockReturnValue({ listOpenPrNumbers, fetchPrListItem });
    expect(await runMerge({ projectCwd: '/project', concurrency: 1, settings: resolveMergeSettings(undefined) }))
      .toEqual({ processedCount: 0, mergedCount: 0, exitCode: 0 });
    expect(listOpenPrNumbers).toHaveBeenCalledWith('/project');
  });

  it('providerが一括取得に未対応なら詳細やworkflowを開始しない', async () => {
    mocks.provider.mockReturnValue({});
    await expect(runMerge({ projectCwd: '/project', concurrency: 1,
      settings: resolveMergeSettings(undefined) })).rejects.toThrow('does not support bulk');
    expect(executePrWorkflow).not.toHaveBeenCalled();
  });

  it('番号一覧の取得失敗では先行番号の詳細やworkflowを開始しない', async () => {
    listOpenPrNumbers.mockImplementation(() => { throw new Error('page failed'); });
    await expect(run()).rejects.toThrow('page failed');
    expect(fetchPrListItem).not.toHaveBeenCalled();
    expect(executePrWorkflow).not.toHaveBeenCalled();
  });

  it('一件の詳細取得失敗を集計し後続PRの処理を続ける', async () => {
    fetchPrListItem.mockImplementation((number: number) => {
      if (number === 123) throw new Error('details unavailable');
      return pr(number);
    });
    expect(await run()).toEqual({ processedCount: 2, mergedCount: 1, exitCode: 1 });
    expect(processedNumbers()).toEqual([456]);
  });

  it('includeDraftはdraftと非draftの両方を対象にする', async () => {
    setPrs([pr(123), pr(456, { draft: true })]);
    await run({ includeDraft: true });
    expect(processedNumbers().sort()).toEqual([123, 456]);
  });

  it.each(['CLI', 'config'])('%sのincludeForks指定でforkと同一repositoryを対象にする', async (source) => {
    setPrs([pr(123), pr(456, { same_repository: false })]);
    await run(source === 'CLI' ? { includeForks: true } : {}, source === 'config' ? { includeForks: true } : {});
    expect(processedNumbers()).toEqual([123, 456]);
  });

  it('same_repository=falseだけではforkの既定除外を迂回しない', async () => {
    setPrs([pr(123), pr(456, { same_repository: false })]);
    await run({}, { where: { same_repository: false } });
    expect(processedNumbers()).toEqual([]);
  });

  it('CLI条件で設定のfork包含とdraft包含を置換する', async () => {
    setPrs([pr(123), pr(456, { same_repository: false }), pr(789, { draft: true })]);
    await run({ where: { author: 'alice' } }, { includeForks: true, includeDraft: true });
    expect(processedNumbers()).toEqual([123]);
  });

  it('includeForksだけのCLI条件で設定条件全体を置換する', async () => {
    setPrs([pr(123), pr(456, { same_repository: false })]);
    await run({ includeForks: true }, { where: { author: 'absent' } });
    expect(processedNumbers()).toEqual([123, 456]);
  });

  it('設定のdraft条件だけでは既定のdraft除外を迂回しない', async () => {
    setPrs([pr(123), pr(456, { draft: true })]);
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
    setPrs([pr(123), pr(456, mismatch)]);
    await run({ where });
    expect(processedNumbers()).toEqual([123]);
  });

  it('CLI条件は設定条件全体を置換し未指定項目を混合しない', async () => {
    setPrs([pr(123), pr(456, { author: 'bob', labels: ['different'] })]);
    await run({ where: { author: 'bob' } }, { where: { author: 'alice', labels: ['ready'], base_branch: 'release' } });
    expect(processedNumbers()).toEqual([456]);
  });

  it('includeDraftだけのCLI指定でも設定条件全体を置換する', async () => {
    setPrs([pr(123), pr(456, { draft: true })]);
    await run({ includeDraft: true }, { where: { author: 'absent' } });
    expect(processedNumbers().sort()).toEqual([123, 456]);
  });

  it('workflowだけのCLI指定では設定条件を保持する', async () => {
    setPrs([pr(123), pr(456, { author: 'bob' })]);
    await run({ workflow: 'custom-review' }, { where: { author: 'bob' }, workflow: 'configured-review' });
    expect(processedNumbers()).toEqual([456]);
    expect(executePrWorkflow.mock.calls[0]?.[0]).toMatchObject({ workflow: 'custom-review' });
  });

  it('workflowを省略した場合は設定のworkflowを使う', async () => {
    await run({ prNumber: 123 }, { workflow: 'configured-review' });
    expect(executePrWorkflow.mock.calls[0]?.[0]).toMatchObject({ workflow: 'configured-review' });
  });

  it('設定のconcurrencyまで並列に開始し一件の例外で後続PRを中止しない', async () => {
    setPrs([pr(123), pr(456), pr(789)]);
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
    setPrs([pr(123), pr(456), pr(789)]);
    executePrWorkflow.mockImplementation(async ({ prNumber }: { prNumber: number }) => ({
      merged: prNumber === 123 ? merged : true,
    }));
    expect(await run()).toEqual({ processedCount: 3, mergedCount: merged ? 3 : 2, exitCode: merged ? 0 : 1 });
    expect(processedNumbers()).toEqual([123, 456, 789]);
  });

  it('対象ゼロならworkflowを起動せず成功終了する', async () => {
    setPrs([]);
    expect(await run()).toMatchObject({ processedCount: 0, mergedCount: 0, exitCode: 0 });
    expect(executePrWorkflow).not.toHaveBeenCalled();
  });

  it('テキスト指定では機械的条件を通過しAIが選択したPRだけを実行する', async () => {
    setPrs([pr(10), pr(11), pr(12, { draft: true }), pr(13, { same_repository: false }), pr(14, { author: 'bob' })]);
    mocks.agent.mockResolvedValueOnce({ status: 'done', structuredOutput: { selected: true, reason: '文書の変更' } })
      .mockResolvedValueOnce({ status: 'done', structuredOutput: { selected: false, reason: '実装を含む' } });
    expect(await run({ selectionText: 'ドキュメントのみ', where: { author: 'alice' } }))
      .toEqual({ processedCount: 1, mergedCount: 1, exitCode: 0 });
    expect(mocks.selectionData.mock.calls.map(([number]) => number)).toEqual([10, 11]);
    expect(mocks.agent).toHaveBeenCalledTimes(2);
    expect(processedNumbers()).toEqual([10]);
  });

  it('テキストだけの指定では設定の選定条件を保持する', async () => {
    setPrs([pr(10), pr(11, { author: 'bob' })]);
    await run({ selectionText: '文書のみ' }, { where: { author: 'bob' } });
    expect(mocks.selectionData.mock.calls.map(([number]) => number)).toEqual([11]);
    expect(processedNumbers()).toEqual([11]);
  });

  it('テキスト指定のCLI条件は設定条件全体を置換する', async () => {
    setPrs([pr(10), pr(11, { author: 'bob', labels: [] })]);
    await run({ selectionText: '文書のみ', where: { author: 'bob' } }, { where: { author: 'alice', labels: ['ready'] } });
    expect(mocks.selectionData.mock.calls.map(([number]) => number)).toEqual([11]);
    expect(processedNumbers()).toEqual([11]);
  });

  it('テキスト指定でも包含オプションを適用してからAIへ渡す', async () => {
    setPrs([pr(10, { draft: true }), pr(11, { same_repository: false })]);
    await run({ selectionText: '文書のみ', includeDraft: true, includeForks: true });
    expect(mocks.selectionData.mock.calls.map(([number]) => number)).toEqual([10, 11]);
    expect(processedNumbers()).toEqual([10, 11]);
  });

  it('テキスト選別後に最新のdraftとwhereを再確認してから実行する', async () => {
    const initialPrs = [pr(10), pr(11), pr(12)];
    const latestPrs = new Map([
      [10, pr(10, { draft: true })],
      [11, pr(11, { labels: [] })],
      [12, pr(12)],
    ]);
    const fetchCounts = new Map<number, number>();
    const events: string[] = [];
    setPrs(initialPrs);
    fetchPrListItem.mockImplementation((number: number) => {
      const count = (fetchCounts.get(number) ?? 0) + 1;
      fetchCounts.set(number, count);
      events.push(`fetch:${number}:${count}`);
      return count === 1 ? initialPrs.find((item) => item.number === number) : latestPrs.get(number);
    });
    mocks.agent.mockImplementation(async () => {
      events.push('judge');
      return { status: 'done', structuredOutput: { selected: true, reason: '文書の変更' } };
    });
    executePrWorkflow.mockImplementation(async ({ prNumber }: { prNumber: number }) => {
      events.push(`execute:${prNumber}`);
      return { merged: true };
    });

    const onSelectionResult = vi.fn();
    await run({ selectionText: '文書のみ', where: { labels: ['ready'] }, onSelectionResult });

    expect(processedNumbers()).toEqual([12]);
    expect(onSelectionResult).toHaveBeenCalledWith([
      { number: 10, selected: false, reason: '文書の変更' },
      { number: 11, selected: false, reason: '文書の変更' },
      { number: 12, selected: true, reason: '文書の変更' },
    ]);
    expect(events).toEqual([
      'fetch:10:1', 'judge', 'fetch:11:1', 'judge', 'fetch:12:1', 'judge',
      'fetch:10:2', 'fetch:11:2', 'fetch:12:2', 'execute:12',
    ]);
  });

  it.each([
    { change: 'draft化', where: {}, latestPr: pr(456, { draft: true }) },
    { change: 'base変更', where: { base_branch: 'main' }, latestPr: pr(456, { base_branch: 'develop' }) },
    { change: '管理マーカー削除', where: { managed_by_takt: true }, latestPr: pr(456, { managed_by_takt: false }) },
    { change: 'close済み', where: {}, latestPr: undefined },
  ])('選択したPRが詳細再取得時に$changeで不適格になったら除外結果を通知する', async ({ where, latestPr }) => {
    const initialPrs = [pr(123), pr(456), pr(789)];
    const fetchCounts = new Map<number, number>();
    const events: string[] = [];
    setPrs(initialPrs);
    fetchPrListItem.mockImplementation((number: number) => {
      const count = (fetchCounts.get(number) ?? 0) + 1;
      fetchCounts.set(number, count);
      events.push(`fetch:${number}:${count}`);
      if (count === 1) return initialPrs.find((item) => item.number === number);
      return number === 456 ? latestPr : initialPrs.find((item) => item.number === number);
    });
    let judgmentIndex = 0;
    mocks.agent.mockImplementation(async () => {
      const candidate = initialPrs[judgmentIndex]!;
      judgmentIndex += 1;
      events.push(`judge:${candidate.number}`);
      return { status: 'done', structuredOutput: {
        selected: candidate.number !== 789, reason: '文書の変更',
      } };
    });
    const onSelectionResult = vi.fn(() => { events.push('report'); });
    executePrWorkflow.mockImplementation(async ({ prNumber }: { prNumber: number }) => {
      events.push(`execute:${prNumber}`);
      return { merged: true };
    });

    await run({ selectionText: '文書のみ', where, onSelectionResult });

    expect(processedNumbers()).toEqual([123]);
    expect(onSelectionResult).toHaveBeenCalledWith([
      { number: 123, selected: true, reason: '文書の変更' },
      { number: 456, selected: false, reason: '文書の変更' },
      { number: 789, selected: false, reason: '文書の変更' },
    ]);
    expect(events).toEqual([
      'fetch:123:1', 'judge:123', 'fetch:456:1', 'judge:456', 'fetch:789:1', 'judge:789',
      'fetch:123:2', 'fetch:456:2', 'report', 'execute:123',
    ]);
  });

  it.each([false, true])('唯一のAI選択済みPRが再取得時にdraft=%sなら通知と処理件数へ反映する', async (draft) => {
    setPrs([pr(456)]);
    fetchPrListItem.mockReturnValueOnce(pr(456)).mockReturnValueOnce(pr(456, { draft }));
    const onSelectionResult = vi.fn();

    expect(await run({ selectionText: '文書のみ', onSelectionResult }))
      .toEqual({ processedCount: draft ? 0 : 1, mergedCount: draft ? 0 : 1, exitCode: 0 });
    expect(onSelectionResult).toHaveBeenCalledWith([
      { number: 456, selected: !draft, reason: '意図に合う' },
    ]);
    expect(processedNumbers()).toEqual(draft ? [] : [456]);
  });

  it('テキスト選別後の詳細再取得が失敗したらworkflowを開始しない', async () => {
    const initialPrs = [pr(123), pr(456)];
    const fetchCounts = new Map<number, number>();
    setPrs(initialPrs);
    fetchPrListItem.mockImplementation((number: number) => {
      const count = (fetchCounts.get(number) ?? 0) + 1;
      fetchCounts.set(number, count);
      if (number === 456 && count === 2) throw new Error('latest details unavailable');
      return initialPrs.find((item) => item.number === number);
    });

    await expect(run({ selectionText: '文書のみ' })).rejects.toThrow('latest details unavailable');

    expect(executePrWorkflow).not.toHaveBeenCalled();
  });

  it('全候補の判定と結果通知を完了してからワークフローを起動する', async () => {
    const events: string[] = [];
    mocks.agent.mockImplementation(async () => {
      events.push('judge');
      expect(executePrWorkflow).not.toHaveBeenCalled();
      return { status: 'done', structuredOutput: { selected: true, reason: '文書の変更' } };
    });
    const onSelectionResult = vi.fn(() => { events.push('report'); });
    executePrWorkflow.mockImplementation(async () => { events.push('execute'); return { merged: true }; });
    await run({ selectionText: '文書のみ', onSelectionResult });
    expect(events).toEqual(['judge', 'judge', 'report', 'execute', 'execute']);
    expect(onSelectionResult).toHaveBeenCalledWith([
      { number: 123, selected: true, reason: '文書の変更' },
      { number: 456, selected: true, reason: '文書の変更' },
    ]);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.confirmWithCancel).not.toHaveBeenCalled();
  });

  it('先行候補を選択した後の判定失敗でも全PRを未処理にする', async () => {
    mocks.agent.mockResolvedValueOnce({ status: 'done', structuredOutput: { selected: true, reason: '文書の変更' } })
      .mockRejectedValueOnce(new Error('provider failed'));
    const onSelectionResult = vi.fn();
    await expect(run({ selectionText: '文書のみ', onSelectionResult })).rejects.toThrow();
    expect(mocks.agent).toHaveBeenCalledTimes(2);
    expect(executePrWorkflow).not.toHaveBeenCalled();
    expect(onSelectionResult).not.toHaveBeenCalled();
  });

  it('先行候補を選択した後の材料取得失敗でも全PRを未処理にする', async () => {
    mocks.selectionData.mockImplementation((number: number) => {
      if (number === 456) throw new Error('files unavailable');
      return { number, title: '文書更新', body: '利用手順', files: ['docs/guide.md'] };
    });
    const onSelectionResult = vi.fn();
    await expect(run({ selectionText: '文書のみ', onSelectionResult })).rejects.toThrow();
    expect(mocks.agent).toHaveBeenCalledOnce();
    expect(executePrWorkflow).not.toHaveBeenCalled();
    expect(onSelectionResult).not.toHaveBeenCalled();
  });

  it('テキスト指定の後続PR詳細取得失敗では先行PRも実行しない', async () => {
    fetchPrListItem.mockImplementation((number: number) => {
      if (number === 456) throw new Error('details unavailable');
      return pr(number);
    });
    await expect(run({ selectionText: '文書のみ' })).rejects.toThrow();
    expect(executePrWorkflow).not.toHaveBeenCalled();
  });

  it('AIが全候補を除外したら処理ゼロで正常終了し除外結果を通知する', async () => {
    mocks.agent.mockResolvedValue({ status: 'done', structuredOutput: { selected: false, reason: '実装を含む' } });
    const onSelectionResult = vi.fn();
    expect(await run({ selectionText: '文書のみ', onSelectionResult }))
      .toEqual({ processedCount: 0, mergedCount: 0, exitCode: 0 });
    expect(executePrWorkflow).not.toHaveBeenCalled();
    expect(onSelectionResult).toHaveBeenCalledWith([
      { number: 123, selected: false, reason: '実装を含む' },
      { number: 456, selected: false, reason: '実装を含む' },
    ]);
  });

  it('機械的候補ゼロならテキスト指定でもAIを呼ばず正常終了する', async () => {
    setPrs([pr(10, { draft: true }), pr(11, { same_repository: false })]);
    expect(await run({ selectionText: '文書のみ' })).toEqual({ processedCount: 0, mergedCount: 0, exitCode: 0 });
    expect(mocks.selectionData).not.toHaveBeenCalled();
    expect(mocks.agent).not.toHaveBeenCalled();
    expect(executePrWorkflow).not.toHaveBeenCalled();
  });

  it('テキスト選別後も並列数を守り実際のマージ結果だけを集計する', async () => {
    setPrs([pr(10), pr(11), pr(12)]);
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    executePrWorkflow.mockImplementation(({ prNumber }: { prNumber: number }) => new Promise((resolve) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      releases.push(() => { active -= 1; resolve({ merged: prNumber !== 10 }); });
    }));
    const running = run({ selectionText: '文書のみ' });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[0]!();
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases[1]!();
    releases[2]!();
    expect(await running).toEqual({ processedCount: 3, mergedCount: 2, exitCode: 1 });
    expect(mocks.agent).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(2);
    expect(processedNumbers()).toEqual([10, 11, 12]);
  });

  it('既定はsimple workflow・squash・自動起動無効・draft除外である', () => {
    expect(resolveMergeSettings(undefined)).toMatchObject({ workflow: 'merge-review-fix-simple', method: 'squash', autoStart: false, includeDraft: false,
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
