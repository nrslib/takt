export async function observe(service, probe) {
  const failure = new Error('operation failed');
  const result = { acquired: 0, released: 0, calls: 0 };
  const signal = { aborted: false };
  result.abortedBeforeAcquire = signal.aborted;
  const pool = {
    acquire() {
      result.acquired += 1;
      if (probe === 'C') signal.aborted = true;
      result.abortedAfterAcquire = signal.aborted;
      return { release() { result.released += 1; } };
    },
  };
  try {
    result.outcome = await service.run(pool, async () => {
      result.calls += 1;
      if (probe === 'B') throw failure;
      return 7;
    }, signal);
  } catch (error) {
    result.outcome = error === failure ? 'original-error' : 'other-error';
  }
  return result;
}
export function satisfied(result, probe) {
  if (result.acquired !== 1 || result.released !== 1 || result.abortedBeforeAcquire !== false) return false;
  if (probe === 'C') {
    return result.abortedAfterAcquire === true && result.calls === 0 && result.outcome?.status === 'cancelled';
  }
  return result.abortedAfterAcquire === false && result.calls === 1
    && (probe === 'B' ? result.outcome === 'original-error' : result.outcome?.status === 'ok' && result.outcome.value === 7);
}
