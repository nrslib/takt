import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runMerge, resolveMergeSettings } from '../features/merge/index.js';
import type { PrListItem } from '../infra/git/types.js';

const mocks = vi.hoisted(() => ({ provider: vi.fn(), agent: vi.fn() }));
vi.mock('../infra/git/index.js', () => ({ getGitProvider: mocks.provider }));
vi.mock('../agents/agent-usecases.js', () => ({ executeAgent: mocks.agent }));

const candidate: PrListItem = {
  number: 10, author: 'alice', labels: ['documentation', 'ready'], base_branch: 'main',
  head_branch: 'docs/guide', managed_by_takt: false, same_repository: true,
  draft: false, updated_at: '2026-10-14T00:00:00Z',
};
const selectionText = 'ドキュメントのみ';
const files = Array.from({ length: 101 }, (_, index) => `docs/guide-${index}.md`);
const fetchPrSelectionData = vi.fn();
const executePrWorkflow = vi.fn();

function run() {
  const options = { projectCwd: '/project', concurrency: 1, selectionText,
    settings: resolveMergeSettings(undefined) };
  return runMerge(options, {
    listOpenPrNumbers: () => [10], fetchPrListItem: () => ({ ...candidate, labels: [...candidate.labels] }),
    executePrWorkflow,
  });
}

describe('Merge AI selection decisions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.provider.mockReturnValue({ fetchPrSelectionData });
    fetchPrSelectionData.mockReturnValue({ number: 10, title: '利用ガイド更新', body: 'PR #10 の手順を説明する', files: [...files],
      patch: 'PRIVATE_DIFF_BODY', comments: ['PRIVATE_REVIEW_COMMENT'] });
    executePrWorkflow.mockResolvedValue({ merged: true });
    mocks.agent.mockResolvedValue({ persona: 'selector', status: 'done', content: '',
      structuredOutput: { selected: true, reason: '文書のみの変更' } });
  });

  it.each([true, false])('構造化されたselected=%sの判定を実行対象へ反映する', async (selected) => {
    mocks.agent.mockResolvedValue({ status: 'done', content: selected ? '除外してください' : '選択してください',
      structuredOutput: { selected, reason: selected ? '文書の判定' : '' } });
    expect(await run()).toEqual({ processedCount: selected ? 1 : 0, mergedCount: selected ? 1 : 0, exitCode: 0 });
    expect(mocks.agent).toHaveBeenCalledOnce();
    expect(executePrWorkflow).toHaveBeenCalledTimes(selected ? 1 : 0);
    if (selected) expect(executePrWorkflow.mock.calls[0]?.[0]).toMatchObject({ prNumber: 10 });
  });

  it('タイトル・本文・ラベル・両ブランチ・全パスだけを判定材料として渡す', async () => {
    await run();
    expect(fetchPrSelectionData).toHaveBeenCalledWith(10, '/project');
    expect(mocks.agent).toHaveBeenCalledOnce();
    const [, prompt, options] = mocks.agent.mock.calls[0]!;
    const payload: unknown = JSON.parse(prompt.slice(prompt.indexOf('{')));
    expect(payload).toEqual({
      selectionText,
      title: '利用ガイド更新',
      body: 'PR #10 の手順を説明する',
      labels: candidate.labels,
      headBranch: candidate.head_branch,
      baseBranch: candidate.base_branch,
      files,
    });
    expect(payload).toHaveProperty('body', 'PR #10 の手順を説明する');
    expect(payload).not.toHaveProperty('number');
    expect(options).toMatchObject({ cwd: '/project', projectCwd: '/project', allowedTools: [], permissionMode: 'readonly',
      outputSchema: expect.objectContaining({ type: 'object' }) });
  });

  it.each([
    undefined, null, {}, 'selected=true', { selected: 'true', reason: '文書' },
    { selected: true }, { selected: true, reason: '' }, { selected: true, reason: '   ' },
  ])('無効な構造化判定%jを自然文で代用せず拒否する', async (structuredOutput) => {
    mocks.agent.mockResolvedValue({ status: 'done', content: '{"selected":true,"reason":"文書"}', structuredOutput });
    await expect(run()).rejects.toThrow();
    expect(mocks.agent).toHaveBeenCalledOnce();
    expect(executePrWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'error', error: 'provider failed' },
    { status: 'blocked' },
    { status: 'done', error: 'provider failed' },
  ])('有効な判定を伴う失敗応答%jでも実行しない', async (failure) => {
    mocks.agent.mockResolvedValue({ ...failure, structuredOutput: { selected: true, reason: '文書' } });
    await expect(run()).rejects.toThrow();
    expect(mocks.agent).toHaveBeenCalledOnce();
    expect(executePrWorkflow).not.toHaveBeenCalled();
  });

  it('プロバイダー例外を全件選択へ読み替えない', async () => {
    mocks.agent.mockRejectedValue(new Error('provider unavailable'));
    await expect(run()).rejects.toThrow();
    expect(mocks.agent).toHaveBeenCalledOnce();
    expect(executePrWorkflow).not.toHaveBeenCalled();
  });

  it('選別材料の取得失敗ではAIもワークフローも起動しない', async () => {
    fetchPrSelectionData.mockImplementation(() => { throw new Error('files unavailable'); });
    await expect(run()).rejects.toThrow();
    expect(mocks.agent).not.toHaveBeenCalled();
    expect(executePrWorkflow).not.toHaveBeenCalled();
  });

  it('選別材料の取得能力がないproviderでは実行しない', async () => {
    mocks.provider.mockReturnValue({});
    await expect(run()).rejects.toThrow();
    expect(mocks.agent).not.toHaveBeenCalled();
    expect(executePrWorkflow).not.toHaveBeenCalled();
  });

});
