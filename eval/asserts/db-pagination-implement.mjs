export default function assertPagination(output) {
  const { measurement } = JSON.parse(output);
  const failures = [];
  if (!Array.isArray(measurement) || measurement.length !== 12) {
    return { pass: false, score: 0, reason: 'independent page/export measurements are missing' };
  }
  for (const sample of measurement) {
    if (sample.exportIds !== undefined) {
      const expected = Array.from({ length: sample.recordCount }, (_, index) => index + 1);
      if (JSON.stringify(sample.exportIds) !== JSON.stringify(expected)) failures.push('export behavior changed');
      continue;
    }
    const ids = sample.page?.items?.map(({ id }) => id);
    if (JSON.stringify(ids) !== JSON.stringify(sample.expectedIds)
      || sample.page.hasMore !== sample.expectedHasMore) failures.push(`page response: ${sample.recordCount}/${sample.offset}`);
    if (sample.page?.items?.some(({ id, title }) => title !== `Record ${id}`)) {
      failures.push(`page title: ${sample.recordCount}/${sample.offset}`);
    }
    // Allow one lookahead row and a separate scalar count query.
    if (!Number.isInteger(sample.fetchedRows) || sample.fetchedRows > 22) {
      failures.push(`DB read exceeds fixture budget: ${sample.fetchedRows} rows for ${sample.recordCount}/${sample.offset}`);
    }
  }
  return { pass: failures.length === 0, score: failures.length === 0 ? 1 : 0, reason: failures.join('; ') || 'correct pages, bounded DB reads, export preserved' };
}
