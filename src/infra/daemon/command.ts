import type { CommandPort, CommandRequest, CommandResult, IoOptions } from '../../core/daemon/io.js';
import { spawnManagedProcess } from '../../shared/utils/spawn.js';
import { ioScope } from './io.js';

export function validateCommand(request: CommandRequest): void {
  if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0) throw new Error('Invalid command output capacity');
}

export class AsyncCommand implements CommandPort {
  async run(request: CommandRequest, options: IoOptions): Promise<CommandResult> {
    validateCommand(request);
    const scope = ioScope(options);
    try {
      const managed = spawnManagedProcess(request.executable, request.args, {
        cwd: request.cwd, env: { ...request.env }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      }, scope.signal);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let remaining = request.maxOutputBytes;
      let truncated = false;
      let termination: Promise<{ error?: unknown }> | undefined;
      const collect = (target: Buffer[], chunk: Buffer): void => {
        const kept = Math.min(remaining, chunk.length);
        if (kept > 0) target.push(Buffer.from(chunk.subarray(0, kept)));
        remaining -= kept;
        if (kept < chunk.length && !truncated) {
          truncated = true;
          termination = managed.terminate().then(() => ({}), (error: unknown) => ({ error }));
        }
      };
      managed.child.stdout!.on('data', (chunk: Buffer) => collect(stdout, chunk));
      managed.child.stderr!.on('data', (chunk: Buffer) => collect(stderr, chunk));
      let exit: Awaited<ReturnType<typeof managed.wait>> | undefined;
      let failure: unknown;
      let failed = false;
      try { exit = await managed.wait(); } catch (error) { failed = true; failure = error; }
      const stopped = await termination;
      if (stopped !== undefined && 'error' in stopped) {
        if (failed) throw new AggregateError([failure, stopped.error], 'Command and termination failed');
        throw stopped.error;
      }
      if (failed) throw failure;
      scope.signal.throwIfAborted();
      if (exit === undefined) throw new Error('Command has no exit result');
      return { ...exit, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), truncated };
    } finally { scope.close(); }
  }
}
