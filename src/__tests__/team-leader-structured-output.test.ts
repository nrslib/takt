import { describe, expect, it } from 'vitest';
import {
  buildDecomposePrompt,
  buildMorePartsPrompt,
  toMorePartsResponse,
  toPartDefinitions,
} from '../agents/team-leader-structured-output.js';
import { loadMorePartsSchema } from '../infra/resources/schema-loader.js';

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
    const prompt = buildDecomposePrompt('Implement the feature.', {
      maxInitialParts: 2,
      language,
      inspectTools: undefined,
      findingContract: undefined,
      rejectedDecomposition: undefined,
    });

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
      undefined,
      [],
    );

    expect(prompt).toContain('x'.repeat(2500));
    expect(prompt).toContain(tailMarker);
    expect(prompt).not.toContain('[truncated]');
    expect(prompt).toContain('done=true and cancelPartIds together');
  });
});

describe('toMorePartsResponse', () => {
  it('取消対象IDを含む有効な追加計画を解析する', () => {
    expect(toMorePartsResponse({
      done: false,
      reasoning: 'replace obsolete verification',
      cancelPartIds: ['verify'],
      parts: [makeRawPart('verify-gates')],
    }, ['verify'])).toEqual({
      done: false,
      reasoning: 'replace obsolete verification',
      cancelPartIds: ['verify'],
      parts: [
        { id: 'verify-gates', title: 'Title verify-gates', instruction: 'Do verify-gates' },
      ],
    });
  });

  it('cancelPartIdsの欠落・空白・重複を拒否する', () => {
    expect(() => toMorePartsResponse({
      done: true,
      reasoning: 'complete',
      parts: [],
    }, [])).toThrow('Structured output "cancelPartIds" must be an array');
    expect(() => toMorePartsResponse({
      done: true,
      reasoning: 'complete',
      cancelPartIds: ['   '],
      parts: [],
    }, [])).toThrow('Structured output "cancelPartIds" entries must be non-empty strings');
    expect(() => toMorePartsResponse({
      done: true,
      reasoning: 'complete',
      cancelPartIds: ['verify', 'verify'],
      parts: [],
    }, ['verify'])).toThrow('Structured output "cancelPartIds" must not contain duplicates');
  });

  it('提示されていないpart IDの取消を拒否する', () => {
    expect(() => toMorePartsResponse({
      done: true,
      reasoning: 'complete',
      cancelPartIds: ['unknown'],
      parts: [],
    }, ['verify'])).toThrow('non-cancellable part ID: unknown');
  });
});

describe('more-parts schema', () => {
  it('cancelPartIdsを必須の重複なし文字列配列として公開する', () => {
    const schema = loadMorePartsSchema();
    const properties = schema.properties as Record<string, unknown>;
    const cancelPartIds = properties.cancelPartIds as Record<string, unknown>;

    expect(schema.required).toEqual(expect.arrayContaining(['cancelPartIds']));
    expect(cancelPartIds).toMatchObject({
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', minLength: 1 },
    });
  });

  it('呼び出しごとに独立したschema cloneを返す', () => {
    const first = loadMorePartsSchema();
    const second = loadMorePartsSchema();
    const firstProperties = first.properties as Record<string, unknown>;
    const secondProperties = second.properties as Record<string, unknown>;

    (firstProperties.cancelPartIds as Record<string, unknown>).uniqueItems = false;

    expect(secondProperties.cancelPartIds).toMatchObject({ uniqueItems: true });
  });
});
