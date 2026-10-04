import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ acquire: vi.fn(), update: vi.fn(), release: vi.fn() }));
vi.mock('../infra/task/project-execution-lock.js', () => ({ acquireProjectExecutionLock: mocks.acquire }));
vi.mock('../shared/ui/index.js', () => ({ blankLine: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../shared/i18n/index.js', () => ({ getLabel: (key: string) => key }));
import { withProjectExecution } from '../features/tasks/execute/projectExecution.js';

describe('withProjectExecution', () => {
  let sigintBefore: ReturnType<typeof process.rawListeners>;
  let exitBefore: ReturnType<typeof process.rawListeners>;

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.acquire.mockReturnValue({ updateState: mocks.update, release: mocks.release });
    sigintBefore = process.rawListeners('SIGINT');
    exitBefore = process.rawListeners('exit');
  });
  afterEach(() => {
    expect(process.rawListeners('SIGINT')).toEqual(sigintBefore);
    expect(process.rawListeners('exit')).toEqual(exitBefore);
    vi.restoreAllMocks();
  });

  it.each(['run', 'watch'] as const)('%s は同じ停止信号で停止中に移り、終了まで保持する', async (kind) => {
    const result = await withProjectExecution('/project', kind, async (signals) => {
      expect(mocks.update).toHaveBeenLastCalledWith('running');
      expect(signals.schedulingSignal.aborted).toBe(false);
      const handler = process.rawListeners('SIGINT').find((listener) => !sigintBefore.includes(listener));
      handler!.call(process, 'SIGINT');
      expect(mocks.update).toHaveBeenLastCalledWith('stopping');
      expect(signals.schedulingSignal.aborted).toBe(true);
      expect(signals.taskAbortSignal.aborted).toBe(kind === 'run');
      expect(mocks.release).not.toHaveBeenCalled();
      return 'done';
    });
    expect(result).toBe('done');
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('同期 exit ハンドラが強制終了時の解放を担当する', async () => {
    await withProjectExecution('/project', 'watch', async () => {
      const handler = process.rawListeners('exit').find((listener) => !exitBefore.includes(listener));
      handler!.call(process, 130);
      expect(mocks.release).toHaveBeenCalledTimes(1);
    });
  });

  it('取得拒否では処理もリスナー登録も行わない', async () => {
    const failure = new Error('conflict');
    mocks.acquire.mockImplementation(() => { throw failure; });
    const execute = vi.fn();
    await expect(withProjectExecution('/project', 'run', execute)).rejects.toBe(failure);
    expect(execute).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('起動時状態更新の例外でも解放する', async () => {
    const failure = new Error('write failed');
    mocks.update.mockImplementationOnce(() => { throw failure; });
    const execute = vi.fn();
    await expect(withProjectExecution('/project', 'run', execute)).rejects.toBe(failure);
    expect(execute).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('終了時状態更新の例外でも解放する', async () => {
    const failure = new Error('stop write failed');
    mocks.update.mockImplementation((state: string) => { if (state === 'stopping') throw failure; });
    await expect(withProjectExecution('/project', 'run', async () => undefined)).rejects.toBe(failure);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('解放失敗は伝播し、リスナーを後片付けする', async () => {
    const failure = new Error('release failed');
    mocks.release.mockImplementation(() => { throw failure; });
    await expect(withProjectExecution('/project', 'watch', async () => undefined)).rejects.toBe(failure);
  });
});
