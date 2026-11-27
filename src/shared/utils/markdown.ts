export function formatCodeBlock(content: string, language: string): string {
  const longestBacktickRun = [...content.matchAll(/`+/g)].reduce((max, match) => Math.max(max, match[0].length), 0);
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}
