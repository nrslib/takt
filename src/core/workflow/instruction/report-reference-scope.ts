/** 現在 scope、exact snapshot、直近の親からルートの順。候補は遅延評価する。 */
export function findReportInScopes<T>(
  current: () => T | undefined,
  snapshot: () => T | undefined,
  ancestors: Iterable<() => T | undefined>,
): T | undefined {
  const local = current();
  if (local !== undefined) return local;
  const exact = snapshot();
  if (exact !== undefined) return exact;
  for (const ancestor of ancestors) {
    const result = ancestor();
    if (result !== undefined) return result;
  }
  return undefined;
}
