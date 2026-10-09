import { performance } from 'node:perf_hooks';

export function readUnixStart(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new RangeError('invalid pid');
  if (pid !== process.pid) return undefined;
  return performance.timeOrigin;
}
