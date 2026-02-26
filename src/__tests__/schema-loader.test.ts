import { beforeEach, describe, expect, it, vi } from 'vitest';

const readFileSyncMock = vi.fn((path: string) => {
  if (path.endsWith('judgment.json')) {
    return JSON.stringify({ type: 'object', properties: { step: { type: 'integer' } } });
  }
  if (path.endsWith('evaluation.json')) {
    return JSON.stringify({ type: 'object', properties: { matched_index: { type: 'integer' } } });
  }
  if (path.endsWith('decomposition.json')) {
    return JSON.stringify({
      type: 'object',
      properties: {
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              instruction: { type: 'string' },
            },
          },
        },
      },
    });
  }
  if (path.endsWith('more-parts.json')) {
    return JSON.stringify({
      type: 'object',
      properties: {
        done: { type: 'boolean' },
        reasoning: { type: 'string' },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              instruction: { type: 'string' },
            },
          },
        },
      },
    });
  }
  throw new Error(`Unexpected schema path: ${path}`);
});

vi.mock('node:fs', () => ({
  readFileSync: readFileSyncMock,
}));

vi.mock('../infra/resources/index.js', () => ({
  getResourcesDir: vi.fn(() => '/mock/resources'),
}));

describe('schema-loader', () => {
  beforeEach(() => {
    vi.resetModules();
    readFileSyncMock.mockClear();
  });

  it('同じスキーマを複数回ロードしても readFileSync は1回だけ', async () => {
    const { loadJudgmentSchema } = await import('../core/piece/schema-loader.js');

    const first = loadJudgmentSchema();
    const second = loadJudgmentSchema();

    expect(first).toEqual(second);
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
    expect(readFileSyncMock).toHaveBeenCalledWith('/mock/resources/schemas/judgment.json', 'utf-8');
  });

  it('loadDecompositionSchema は maxItems を注入し、呼び出しごとに独立したオブジェクトを返す', async () => {
    const { loadDecompositionSchema } = await import('../core/piece/schema-loader.js');

    const first = loadDecompositionSchema(2);
    const second = loadDecompositionSchema(5);

    const firstParts = (first.properties as Record<string, unknown>).parts as Record<string, unknown>;
    const secondParts = (second.properties as Record<string, unknown>).parts as Record<string, unknown>;

    expect(firstParts.maxItems).toBe(2);
    expect(secondParts.maxItems).toBe(5);
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('loadDecompositionSchema は不正な maxParts を拒否する', async () => {
    const { loadDecompositionSchema } = await import('../core/piece/schema-loader.js');

    expect(() => loadDecompositionSchema(0)).toThrow('maxParts must be a positive integer: 0');
    expect(() => loadDecompositionSchema(-1)).toThrow('maxParts must be a positive integer: -1');
  });

  it('loadMorePartsSchema は maxItems を注入し、呼び出しごとに独立したオブジェクトを返す', async () => {
    const { loadMorePartsSchema } = await import('../core/piece/schema-loader.js');

    const first = loadMorePartsSchema(1);
    const second = loadMorePartsSchema(4);

    const firstParts = (first.properties as Record<string, unknown>).parts as Record<string, unknown>;
    const secondParts = (second.properties as Record<string, unknown>).parts as Record<string, unknown>;

    expect(firstParts.maxItems).toBe(1);
    expect(secondParts.maxItems).toBe(4);
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('loadMorePartsSchema は不正な maxAdditionalParts を拒否する', async () => {
    const { loadMorePartsSchema } = await import('../core/piece/schema-loader.js');

    expect(() => loadMorePartsSchema(0)).toThrow('maxAdditionalParts must be a positive integer: 0');
    expect(() => loadMorePartsSchema(-1)).toThrow('maxAdditionalParts must be a positive integer: -1');
  });
});
