import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(), update: vi.fn(), release: vi.fn(),
  forceExitAfterOpenCodeCleanup: vi.fn<() => Promise<void>>(),
  preparePoolForForcedShutdown: vi.fn<() => Promise<void>>(),
  logError: vi.fn(),
}));
vi.mock('../infra/task/project-execution-lock.js', () => ({ acquireProjectExecutionLock: mocks.acquire }));
vi.mock('../features/tasks/execute/forceShutdown.js', () => ({
  forceExitAfterOpenCodeCleanup: mocks.forceExitAfterOpenCodeCleanup,
}));
vi.mock('../infra/opencode/server-pool.js', () => ({
  prepareSharedServerPoolForForcedShutdown: mocks.preparePoolForForcedShutdown,
}));
vi.mock('../shared/ui/index.js', () => ({ blankLine: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../shared/i18n/index.js', () => ({ getLabel: (key: string) => key }));
vi.mock('../shared/utils/debug.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../shared/utils/debug.js')>(),
  createLogger: () => ({ error: mocks.logError }),
}));
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
    vi.unstubAllEnvs();
    vi.useRealTimers();
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

  it.each([
    { kind: 'run', trigger: 'SIGINT 再入力' },
    { kind: 'watch', trigger: 'SIGINT 再入力' },
    { kind: 'run', trigger: '停止タイムアウト' },
    { kind: 'watch', trigger: '停止タイムアウト' },
  ] as const)('$kind の $trigger は OpenCode の後片付けへ委譲し、終了までロックを保持する', async ({ kind, trigger }) => {
    vi.useFakeTimers();
    vi.stubEnv('TAKT_SHUTDOWN_TIMEOUT_MS', '100');
    mocks.forceExitAfterOpenCodeCleanup.mockReturnValue(new Promise(() => {}));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    let exitHandler: ReturnType<typeof process.rawListeners>[number] | undefined;
    await withProjectExecution('/project', kind, async () => {
      exitHandler = process.rawListeners('exit').find((listener) => !exitBefore.includes(listener));
      const handler = process.rawListeners('SIGINT').find((listener) => !sigintBefore.includes(listener));
      handler!.call(process, 'SIGINT');
      expect(mocks.forceExitAfterOpenCodeCleanup).not.toHaveBeenCalled();
      if (trigger === 'SIGINT 再入力') {
        handler!.call(process, 'SIGINT');
      } else {
        await vi.advanceTimersByTimeAsync(100);
      }
      handler!.call(process, 'SIGINT');
      await vi.advanceTimersByTimeAsync(100);

      expect(mocks.forceExitAfterOpenCodeCleanup).toHaveBeenCalledOnce();
      expect(exit).not.toHaveBeenCalled();
      expect(mocks.release).not.toHaveBeenCalled();
      expect(mocks.update).toHaveBeenLastCalledWith('stopping');
    });
    expect(mocks.release).not.toHaveBeenCalled();
    expect(process.rawListeners('exit')).toContain(exitHandler);
    expect(process.rawListeners('SIGINT')).toHaveLength(sigintBefore.length + 1);
    expect(mocks.update).toHaveBeenCalledTimes(2);
    exitHandler!.call(process, 130);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it.each(['run', 'watch'] as const)('%s のタスク例外でも強制終了中はプロセス終了まで保持する', async (kind) => {
    mocks.forceExitAfterOpenCodeCleanup.mockReturnValue(new Promise(() => {}));
    const failure = new Error('task failed during forced cleanup');
    let exitHandler: ReturnType<typeof process.rawListeners>[number] | undefined;
    await expect(withProjectExecution('/project', kind, async () => {
      exitHandler = process.rawListeners('exit').find((listener) => !exitBefore.includes(listener));
      const handler = process.rawListeners('SIGINT').find((listener) => !sigintBefore.includes(listener));
      handler!.call(process, 'SIGINT');
      handler!.call(process, 'SIGINT');
      throw failure;
    })).rejects.toBe(failure);

    expect(mocks.release).not.toHaveBeenCalled();
    expect(process.rawListeners('exit')).toContain(exitHandler);
    expect(process.rawListeners('SIGINT')).toHaveLength(sigintBefore.length + 1);
    exitHandler!.call(process, 130);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it.each([
    { kind: 'run', outcome: '失敗' },
    { kind: 'watch', outcome: '失敗' },
    { kind: 'run', outcome: 'タイムアウト' },
    { kind: 'watch', outcome: 'タイムアウト' },
  ] as const)('$kind の後片付けが $outcome でも終了コード 130 でロックとハンドラーを解放する', async ({ kind, outcome }) => {
    vi.resetModules();
    vi.useFakeTimers();
    const actual = await vi.importActual<typeof import('../features/tasks/execute/forceShutdown.js')>(
      '../features/tasks/execute/forceShutdown.js',
    );
    mocks.forceExitAfterOpenCodeCleanup.mockImplementation(actual.forceExitAfterOpenCodeCleanup);
    let rejectCleanup!: (reason: Error) => void;
    mocks.preparePoolForForcedShutdown.mockReturnValue(new Promise<void>((_resolve, reject) => {
      rejectCleanup = reject;
    }));
    let exitHandler: ReturnType<typeof process.rawListeners>[number] | undefined;
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      expect(mocks.release).not.toHaveBeenCalled();
      exitHandler!.call(process, 130);
      return undefined as never;
    }) as never);

    await withProjectExecution('/project', kind, async () => {
      exitHandler = process.rawListeners('exit').find((listener) => !exitBefore.includes(listener));
      const handler = process.rawListeners('SIGINT').find((listener) => !sigintBefore.includes(listener));
      handler!.call(process, 'SIGINT');
      handler!.call(process, 'SIGINT');
    });
    expect(mocks.preparePoolForForcedShutdown).toHaveBeenCalledOnce();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(process.rawListeners('exit')).toContain(exitHandler);
    expect(process.rawListeners('SIGINT')).toHaveLength(sigintBefore.length + 1);

    if (outcome === '失敗') rejectCleanup(new Error('cleanup failed'));
    await vi.advanceTimersByTimeAsync(outcome === 'タイムアウト' ? 5_000 : 0);

    expect(exit).toHaveBeenCalledExactlyOnceWith(130);
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('取得拒否では処理もリスナー登録も行わない', async () => {
    const failure = new Error('conflict');
    mocks.acquire.mockImplementation(() => { throw failure; });
    const execute = vi.fn();
    await expect(withProjectExecution('/project', 'run', execute)).rejects.toBe(failure);
    expect(execute).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it.each(['run', 'watch'] as const)('%s は初回 SIGINT の状態更新失敗を記録して停止と強制終了を続行する', async (kind) => {
    vi.useFakeTimers();
    vi.stubEnv('TAKT_SHUTDOWN_TIMEOUT_MS', '100');
    const failure = new Error('stop write failed');
    mocks.update.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw failure; });
    mocks.forceExitAfterOpenCodeCleanup.mockReturnValue(new Promise(() => {}));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    let exitHandler: ReturnType<typeof process.rawListeners>[number] | undefined;
    await withProjectExecution('/project', kind, async (signals) => {
      exitHandler = process.rawListeners('exit').find((listener) => !exitBefore.includes(listener));
      const handler = process.rawListeners('SIGINT').find((listener) => !sigintBefore.includes(listener));
      expect(() => handler!.call(process, 'SIGINT')).not.toThrow();
      expect(mocks.update).toHaveBeenLastCalledWith('stopping');
      expect(mocks.logError).toHaveBeenCalledOnce();
      expect(mocks.logError.mock.calls[0]?.[1]).toEqual({ error: failure.message });
      expect(signals.schedulingSignal.aborted).toBe(true);
      expect(signals.taskAbortSignal.aborted).toBe(kind === 'run');
      expect(mocks.forceExitAfterOpenCodeCleanup).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(mocks.forceExitAfterOpenCodeCleanup).toHaveBeenCalledOnce();
      expect(mocks.release).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    });
    expect(mocks.release).not.toHaveBeenCalled();
    expect(process.rawListeners('exit')).toContain(exitHandler);
    exitHandler!.call(process, 130);
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
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
