export interface RecordPageInfo {
  total: number;
  nextOffset: number | null;
  omitted: number;
  oversized: boolean;
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function selectRecordPage(
  total: number, offset: number, limit: number, budget: number, sizeAt: (index: number) => number,
): RecordPageInfo & { endOffset: number } {
  let used = 2;
  let index = offset;
  let oversized = false;
  for (; index < total && index - offset < limit; index += 1) {
    const size = sizeAt(index) + 1;
    if (used + size > budget) { oversized = index === offset; break; }
    used += size;
  }
  return { total, endOffset: index, nextOffset: index < total ? index : null,
    omitted: total - (index - offset), oversized };
}

export function boundedRecords<T>(
  records: readonly T[], offset: number, limit: number, budget: number,
): RecordPageInfo & { records: T[] } {
  const { endOffset, ...info } = selectRecordPage(records.length, offset, limit, budget, (index) => jsonBytes(records[index]));
  return { records: records.slice(offset, endOffset), ...info };
}
