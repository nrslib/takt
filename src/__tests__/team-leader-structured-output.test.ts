import { describe, expect, it } from 'vitest';
import { buildDecomposePrompt, buildMorePartsPrompt, toPartDefinitions } from '../agents/team-leader-structured-output.js';

function makeRawPart(id: string): Record<string, string> {
  return {
    id,
    title: `Title ${id}`,
    instruction: `Do ${id}`,
  };
}

describe('toPartDefinitions', () => {
  it('initial_max_parts の上限内なら5パートを受け付ける', () => {
    const rawParts = ['p1', 'p2', 'p3', 'p4', 'p5'].map(makeRawPart);

    const result = toPartDefinitions(rawParts, 5);

    expect(result.map((part) => part.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });

  it('initial_max_parts を超えたら明確なエラーにする', () => {
    const rawParts = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map(makeRawPart);

    expect(() => toPartDefinitions(rawParts, 5)).toThrow(
      'Structured output produced too many initial parts: 6 > initial_max_parts 5',
    );
  });

  it('initial_max_parts 未指定時はpart数を制限しない', () => {
    const rawParts = Array.from({ length: 25 }, (_, index) => makeRawPart(`p${index + 1}`));

    expect(toPartDefinitions(rawParts)).toHaveLength(25);
  });
});

describe('Team Leader decomposition prompt', () => {
  it.each([
    ['en', 'Every part in the same batch must be independently executable', 'Add verification only in a later batch after the implementation results are complete'],
    ['ja', '同じバッチ内の part は互いに独立させる', '検証が必要なら、実装結果がそろった後の後続 batch で追加する'],
  ] as const)('%s prompt requires independent batches and deferred verification', (language, independenceRule, verificationRule) => {
    const prompt = buildDecomposePrompt('Implement the feature.', 2, language);

    expect(prompt).toContain(independenceRule);
    expect(prompt).toContain(verificationRule);
    expect(prompt).not.toContain('Separate implementation parts from verification parts');
    expect(prompt).not.toContain('Put heavy Quality Gates in a final verification part');
  });
});

describe('Team Leader feedback prompt', () => {
  it('includes complete part content beyond 2,000 characters', () => {
    const tailMarker = 'TAIL_MARKER: completed result remains available';
    const content = `${'x'.repeat(2500)}\n${tailMarker}`;

    const prompt = buildMorePartsPrompt(
      'Complete the implementation.',
      [{ id: 'part-1', title: 'Implementation', status: 'done', content }],
      ['part-1'],
      'en',
    );

    expect(prompt).toContain('x'.repeat(2500));
    expect(prompt).toContain(tailMarker);
    expect(prompt).not.toContain('[truncated]');
  });
});
