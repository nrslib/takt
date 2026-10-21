import { execFile } from 'node:child_process';
import { PR_STATUS_TIMEOUT_MS, PrStatusTimeoutError,
  type PrStatusFetchOptions } from '../../core/workflow/system/pr-execution-context.js';

export async function runPrCommand(
  args: string[], cwd: string, options?: PrStatusFetchOptions, maxBuffer = 1024 * 1024,
): Promise<string> {
  const signal = options?.signal;
  signal?.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    let terminationError: unknown;
    const child = execFile('gh', args, { cwd, encoding: 'utf-8', maxBuffer }, (error, stdout) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (terminationError !== undefined) reject(terminationError);
      else if (error !== null) reject(error);
      else resolve(stdout);
    });
    // Wait for exit through the callback, including on cancellation.
    const terminate = (error: unknown) => {
      if (terminationError !== undefined) return;
      terminationError = error;
      child.kill('SIGKILL');
    };
    const abort = () => terminate(signal!.reason);
    const timer = setTimeout(() => terminate(new PrStatusTimeoutError()), options?.timeoutMs ?? PR_STATUS_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
