function stringifyNormalizedJson(value: unknown): string {
  const normalized = typeof value === 'string' ? JSON.parse(value) : value;
  return JSON.stringify(normalized, null, 2);
}

export function renderFencedJsonBlock(value: unknown): string {
  const content = stringifyNormalizedJson(value);
  const maxBacktickRun = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = '`'.repeat(Math.max(3, maxBacktickRun + 1));
  return [fence + 'json', content, fence].join('\n');
}
