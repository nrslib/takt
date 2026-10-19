import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runMerge, resolveMergeSettings, ui, resolveConfigValue } = vi.hoisted(() => ({
  runMerge: vi.fn(), resolveMergeSettings: vi.fn(), resolveConfigValue: vi.fn(),
  ui: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), status: vi.fn() },
}));
vi.mock('../app/cli/initialization.js', () => ({
  getCliExecutionContext: () => ({ cwd: '/project' }),
  assertConfigDirsDoNotCollide: vi.fn(),
  initializeCliExecutionContext: vi.fn(async () => undefined),
}));
vi.mock('../app/cli/updateCheck.js', () => ({ runUpdateCheck: vi.fn(async () => undefined) }));
vi.mock('../infra/config/index.js', () => ({ resolveConfigValue }));
vi.mock('../features/merge/index.js', () => ({ runMerge, resolveMergeSettings }));
vi.mock('../shared/ui/index.js', () => ui);
vi.mock('../shared/i18n/index.js', () => ({
  getLabel: (key: string, _language: string, values?: Record<string, string>) => `${key} ${JSON.stringify(values)}`,
}));

import '../app/cli/commands.js';
import { program } from '../app/cli/program.js';

function mergeCommand() {
  const command = program.commands.find((candidate) => candidate.name() === 'merge');
  if (!command) throw new Error('takt merge is not registered');
  command.exitOverride();
  command.configureOutput({ writeErr: () => {} });
  return command;
}

const previousExitCode = process.exitCode;

describe('takt merge CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    const config: Record<string, unknown> = { language: 'en', concurrency: 3 };
    resolveConfigValue.mockImplementation((_cwd: string, key: string) => config[key]);
    resolveMergeSettings.mockReturnValue({ workflow: 'merge-review-fix-simple', method: 'squash', concurrency: 4, autoStart: false, includeDraft: false });
    runMerge.mockResolvedValue({ processedCount: 2, mergedCount: 2, exitCode: 0 });
    const command = program.commands.find((candidate) => candidate.name() === 'merge');
    for (const option of command?.options ?? []) {
      command!.setOptionValueWithSource(option.attributeName(), option.defaultValue, 'default');
    }
  });
  afterEach(() => { process.exitCode = previousExitCode; });

  it('番号省略で一括処理を起動しmerge設定のconcurrencyを渡す', async () => {
    await mergeCommand().parseAsync([], { from: 'user' });
    expect(runMerge).toHaveBeenCalledOnce();
    expect(runMerge.mock.calls[0]?.[0]).toMatchObject({ projectCwd: '/project', concurrency: 4 });
    expect(process.exitCode).toBe(0);
  });

  it('CLIのconcurrencyをmerge設定より優先する', async () => {
    await mergeCommand().parseAsync(['--concurrency', '5'], { from: 'user' });
    expect(runMerge.mock.calls[0]?.[0]).toMatchObject({ concurrency: 5 });
  });

  it('PR番号と全条件・workflowオプションを受け付ける', async () => {
    await mergeCommand().parseAsync(['123', '--author', 'alice', '--label', 'ready', '--label', 'automation',
      '--base', 'main', '--head', 'takt/*', '--managed-by-takt', '--include-forks', '--include-draft',
      '--workflow', 'merge-review'], { from: 'user' });
    expect(runMerge.mock.calls[0]?.[0]).toMatchObject({ prNumber: 123, workflow: 'merge-review', includeDraft: true, includeForks: true,
      where: { author: 'alice', labels: ['ready', 'automation'], base_branch: 'main', head_branch: 'takt/*',
        managed_by_takt: true } });
    expect(runMerge.mock.calls[0]?.[0].selectionText).toBeUndefined();
  });

  it.each([
    [3, 2], [4, 2], [3, 1],
  ])('処理%d件・マージ%d件を各ラベルへ対応付け未マージの終了コードを返す', async (processedCount, mergedCount) => {
    runMerge.mockResolvedValue({ processedCount, mergedCount, exitCode: 1 });
    await mergeCommand().parseAsync([], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(ui.info).toHaveBeenCalledWith(`Processed: ${processedCount}, merged: ${mergedCount}`);
  });

  it('実行例外で終了コードを非ゼロにする', async () => {
    runMerge.mockRejectedValue(new Error('merge workflow failed'));
    await mergeCommand().parseAsync(['123'], { from: 'user' });
    expect(process.exitCode).not.toBe(0);
    expect(process.exitCode).toBeDefined();
    expect(ui.error).toHaveBeenCalled();
  });

  it.each(['0', '9007199254740992'])('不正なPR番号%sでは処理を開始しない', async (value) => {
    await expect(mergeCommand().parseAsync([value], { from: 'user' })).rejects.toThrow();
    expect(runMerge).not.toHaveBeenCalled();
  });

  it.each(['プロンプト変更以外', 'abc', '1.5', '-1'])('数値以外の位置引数%sを選別テキストとして渡す', async (selectionText) => {
    await mergeCommand().parseAsync(['--', selectionText], { from: 'user' });
    expect(runMerge).toHaveBeenCalledOnce();
    expect(runMerge.mock.calls[0]?.[0]).toMatchObject({ selectionText });
    expect(runMerge.mock.calls[0]?.[0].prNumber).toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it.each(['', '   '])('空の選別テキスト%jでは処理を開始しない', async (value) => {
    await expect(mergeCommand().parseAsync([value], { from: 'user' })).rejects.toThrow();
    expect(runMerge).not.toHaveBeenCalled();
  });

  it('選択番号と理由・除外番号を通常出力に表示する', async () => {
    runMerge.mockImplementation(async (options) => {
      options.onSelectionResult([
        { number: 10, selected: true, reason: 'ドキュメントだけの変更' },
        { number: 11, selected: false, reason: '実装を含む' },
      ]);
      return { processedCount: 1, mergedCount: 1, exitCode: 0 };
    });
    await mergeCommand().parseAsync(['ドキュメントのみ'], { from: 'user' });
    const lines = ui.info.mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => /#?10\b/u.test(line) && line.includes('ドキュメントだけの変更'))).toBe(true);
    expect(lines.some((line) => /#?11\b/u.test(line))).toBe(true);
    expect(ui.info).toHaveBeenCalledWith('Processed: 1, merged: 1');
    expect(process.exitCode).toBe(0);
  });

  it('テキスト選別の失敗を非ゼロ終了として表示する', async () => {
    runMerge.mockRejectedValue(new Error('AI selection failed'));
    await mergeCommand().parseAsync(['ドキュメントのみ'], { from: 'user' });
    expect(runMerge).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    expect(ui.error).toHaveBeenCalledWith(expect.stringContaining('AI selection failed'));
    expect(ui.info).not.toHaveBeenCalledWith(expect.stringContaining('Processed:'));
  });

  it('位置引数を二つ指定した場合は処理を開始しない', async () => {
    await expect(mergeCommand().parseAsync(['123', '文書のみ'], { from: 'user' })).rejects.toThrow();
    expect(runMerge).not.toHaveBeenCalled();
  });

  it('選択理由の端末制御文字を通常出力へ渡さない', async () => {
    runMerge.mockImplementation(async (options) => {
      options.onSelectionResult([{ number: 10, selected: true, reason: '\u001b[31m文書の変更\u001b[0m' }]);
      return { processedCount: 1, mergedCount: 1, exitCode: 0 };
    });
    await mergeCommand().parseAsync(['文書のみ'], { from: 'user' });
    const line = ui.info.mock.calls.map(([value]) => String(value)).find((value) => value.includes('#10'));
    expect(line).toContain('文書の変更');
    expect(line).not.toContain('\u001b');
  });

  it('テキスト選別ゼロ件の処理件数を表示し正常終了する', async () => {
    runMerge.mockResolvedValue({ processedCount: 0, mergedCount: 0, exitCode: 0 });
    await mergeCommand().parseAsync(['ドキュメントのみ'], { from: 'user' });
    expect(runMerge).toHaveBeenCalledOnce();
    expect(ui.info).toHaveBeenCalledWith('Processed: 0, merged: 0');
    expect(process.exitCode).toBe(0);
  });

  it.each(['0', '-1', '1.5', '9007199254740992'])('不正なconcurrency %sで処理を開始しない', async (value) => {
    await expect(mergeCommand().parseAsync(['--concurrency', value], { from: 'user' })).rejects.toThrow();
    expect(runMerge).not.toHaveBeenCalled();
  });
});
