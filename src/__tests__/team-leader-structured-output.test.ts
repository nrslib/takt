import { describe, expect, it } from 'vitest';
import { toPartDefinitions } from '../agents/team-leader-structured-output.js';

function makeRawPart(id: string): Record<string, string> {
  return {
    id,
    title: `Title ${id}`,
    instruction: `Do ${id}`,
  };
}

describe('toPartDefinitions', () => {
  it('総 parts 数の上限内なら5パートを受け付ける', () => {
    const rawParts = ['p1', 'p2', 'p3', 'p4', 'p5'].map(makeRawPart);

    const result = toPartDefinitions(rawParts, 5);

    expect(result.map((part) => part.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });

  it('総 parts 数の上限を超えたら明確なエラーにする', () => {
    const rawParts = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map(makeRawPart);

    expect(() => toPartDefinitions(rawParts, 5)).toThrow(
      'Structured output produced too many total parts: 6 > max_total_parts 5',
    );
  });
});
