import { resetSharedServer } from '../../infra/opencode/client.js';

type ProcessLike = {
  once: (event: 'exit', listener: (code: number) => void) => unknown;
};

export function installOpencodeExitCleanup(
  runtime: ProcessLike = process,
): void {
  runtime.once('exit', () => {
    resetSharedServer();
  });
}
