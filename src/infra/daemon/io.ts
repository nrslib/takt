import type { IoOptions } from '../../core/daemon/io.js';

export function ioScope(options: IoOptions): { signal: AbortSignal; close(): void } {
  options.signal.throwIfAborted();
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) throw new Error('Invalid I/O timeout');
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException('I/O deadline exceeded', 'TimeoutError')), options.timeoutMs);
  return { signal: AbortSignal.any([options.signal, timeout.signal]), close: () => clearTimeout(timer) };
}
