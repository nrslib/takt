import { expect } from 'vitest';

export function expectUndeliveredPrompt(
  prompt: string,
  messages: readonly string[],
  current: string,
): void {
  const transcript = messages.map((message) => `User: ${message}`).join('\n');
  const start = prompt.lastIndexOf(`\n${transcript}\n`);
  expect(start, 'the full original messages must be quoted in sending order').toBeGreaterThan(0);
  const prefix = prompt.slice(0, start);
  const opening = prefix.slice(prefix.lastIndexOf('\n') + 1);
  expect(opening).toMatch(/^`{3,}(?:text)?$/u);
  const fence = opening.replace(/text$/u, '');
  const longestRun = Math.max(0, ...Array.from(transcript.matchAll(/`+/gu), (match) => match[0].length));
  expect(fence.length).toBeGreaterThan(longestRun);
  const explanation = prefix.slice(0, prefix.length - opening.length).trim().split('\n').at(-1) ?? '';
  expect(explanation).toMatch(/interrupt|abort|cancel|中断/iu);
  expect(explanation).toMatch(/user|ユーザー/iu);
  expect(explanation).toMatch(/instruction|request|指示/iu);
  expect(explanation).toMatch(/together|along(?:side| with)|current|今回|合わせ/iu);
  expect(explanation).not.toMatch(/reference (?:only|material)|not.{0,40}(?:instruction|request)|参考情報/iu);
  expect(prompt.slice(start)).toBe(`\n${transcript}\n${fence}\n\n${current}`);
}
