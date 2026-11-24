import { FileAsyncLock } from './lock.js';

export async function acquireFileLocks(paths: readonly string[], signal: AbortSignal): Promise<() => Promise<void>> {
  const releases: Array<() => Promise<void>> = [];
  const release = async () => {
    const failures: unknown[] = [];
    for (const unlock of [...releases].reverse()) {
      try { await unlock(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'File lock cleanup failed');
  };
  try {
    for (const path of [...new Set(paths)].sort()) {
      signal.throwIfAborted();
      releases.push(await new FileAsyncLock().acquire(path, { signal, timeoutMs: 5000 }));
    }
    signal.throwIfAborted();
    return release;
  } catch (error) {
    try { await release(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'File lock acquisition and cleanup failed'); }
    throw error;
  }
}

export async function withFileLocks<T>(paths: readonly string[], signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  const release = await acquireFileLocks(paths, signal);
  const failures: unknown[] = [];
  let value!: T;
  try { signal.throwIfAborted(); value = await action(); } catch (error) { failures.push(error); }
  try { await release(); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'File lock operation and cleanup failed');
  return value;
}
