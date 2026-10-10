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
    resolveMergeSettings.mockReturnValue({ workflow: 'merge-review-fix', method: 'squash', autoStart: false, includeDraft: false });
    runMerge.mockResolvedValue({ processedCount: 2, mergedCount: 2, exitCode: 0 });
    const command = program.commands.find((candidate) => candidate.name() === 'merge');
    for (const option of command?.options ?? []) {
      command!.setOptionValueWithSource(option.attributeName(), option.defaultValue, 'default');
    }
  });
  afterEach(() => { process.exitCode = previousExitCode; });

  it('番号省略で一括処理を起動し既存concurrencyを渡す', async () => {
    await mergeCommand().parseAsync([], { from: 'user' });
    expect(runMerge).toHaveBeenCalledOnce();
    expect(runMerge.mock.calls[0]?.[0]).toMatchObject({ projectCwd: '/project', concurrency: 3 });
    expect(process.exitCode).toBe(0);
  });

  it('PR番号と全条件・workflowオプションを受け付ける', async () => {
    await mergeCommand().parseAsync(['123', '--author', 'alice', '--label', 'ready', '--label', 'automation',
      '--base', 'main', '--head', 'takt/*', '--managed-by-takt', '--include-forks', '--include-draft',
      '--workflow', 'merge-review'], { from: 'user' });
    expect(runMerge.mock.calls[0]?.[0]).toMatchObject({ prNumber: 123, workflow: 'merge-review', includeDraft: true, includeForks: true,
      where: { author: 'alice', labels: ['ready', 'automation'], base_branch: 'main', head_branch: 'takt/*',
        managed_by_takt: true } });
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

  it.each(['0', '-1', 'abc', '1.5', '9007199254740992'])('不正なPR番号%sでは処理を開始しない', async (value) => {
    await expect(mergeCommand().parseAsync([value], { from: 'user' })).rejects.toThrow();
    expect(runMerge).not.toHaveBeenCalled();
  });
});
