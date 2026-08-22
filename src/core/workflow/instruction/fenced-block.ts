function renderFencedBlock(content: string, language: string, minimumFenceLength: number): string {
  const maxBacktickRun = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = '`'.repeat(Math.max(minimumFenceLength, maxBacktickRun + 1));
  return [`${fence}${language}`, content, fence].join('\n');
}

export function renderFencedJsonBlock(value: unknown): string {
  const normalized = typeof value === 'string' ? JSON.parse(value) : value;
  return renderFencedBlock(JSON.stringify(normalized, null, 2), 'json', 3);
}

export function renderFencedTextBlock(content: string): string {
  return renderFencedBlock(content, 'text', 5);
}
