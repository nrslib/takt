import { setTimeout as delay } from 'node:timers/promises';
import { spawnManagedProcess, terminatePosixProcessTree, type ManagedProcessExit } from '../../shared/utils/spawn.js';
import { startWindowsWaitCommand } from './windowsWaitCommand.js';

export type WaitCommandStop = 'timed_out' | 'cancelled';
export interface WaitCommandExit extends ManagedProcessExit {
  readonly stopped?: WaitCommandStop;
}
export interface WaitCommandProcess {
  // 停止処理の失敗では settle せず、所有するプロセス群の終了まで待つ。
  wait(): Promise<WaitCommandExit>;
  stop(reason: WaitCommandStop): Promise<void>;
}

function isProcessGroupRunning(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

export function startWaitCommand(command: string, cwd: string, collect: (chunk: Buffer) => void): WaitCommandProcess {
  if (process.platform === 'win32') return startWindowsWaitCommand(command, cwd, collect);
  const managed = spawnManagedProcess(command, [], {
    cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }, undefined);
  managed.child.stdout!.on('data', collect);
  managed.child.stderr!.on('data', collect);
  let stopped: WaitCommandStop | undefined;
  let termination: Promise<void> | undefined;
  const stop = (reason: WaitCommandStop): Promise<void> => termination ??= (async () => {
    // 消滅済みグループへの要求は自然終了。成功した停止だけを結果へ反映する。
    if (await terminatePosixProcessTree(managed.child.pid)) stopped = reason;
  })().finally(() => { termination = undefined; });
  return {
    async wait() {
      const exit = await managed.wait();
      // close はリダイレクト済みの子孫を待たないため、グループ消滅まで所有する。
      while (true) {
        // 停止失敗は stop の呼び出し元へ返し、wait は子孫の所有を続ける。
        if (termination !== undefined) {
          await termination.catch(() => {});
          continue;
        }
        try {
          if (managed.child.pid === undefined || !isProcessGroupRunning(managed.child.pid)) return { ...exit, stopped };
        } catch (error) {
          // 監視不能は消滅の証拠ではない。停止を試み、確認できるまでグループを所有する。
          collect(Buffer.from(`\nProcess group monitoring failed: ${String(error)}`));
          await stop('cancelled').catch((stopError: unknown) => {
            collect(Buffer.from(`\nProcess group stop failed: ${String(stopError)}`));
          });
        }
        await delay(50);
      }
    },
    stop,
  };
}
