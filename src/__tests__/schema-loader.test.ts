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
    const { loadJudgmentSchema } = await import('../infra/resources/schema-loader.js');

    const first = loadJudgmentSchema();
    const second = loadJudgmentSchema();

    expect(first).toEqual(second);
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
    expect(readFileSyncMock).toHaveBeenCalledWith('/mock/resources/schemas/judgment.json', 'utf-8');
  });

  it('loadDecompositionSchema は指定された初回part数を maxItems に設定する', async () => {
    const { loadDecompositionSchema } = await import('../infra/resources/schema-loader.js');

    const first = loadDecompositionSchema(2);
    const second = loadDecompositionSchema(5);

    const firstParts = (first.properties as Record<string, unknown>).parts as Record<string, unknown>;
    const secondParts = (second.properties as Record<string, unknown>).parts as Record<string, unknown>;

    expect(firstParts.maxItems).toBe(2);
    expect(secondParts.maxItems).toBe(5);
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('loadDecompositionSchema は未指定時にpart数を制限しない', async () => {
    const { loadDecompositionSchema } = await import('../infra/resources/schema-loader.js');

    const schema = loadDecompositionSchema();
    const parts = (schema.properties as Record<string, unknown>).parts as Record<string, unknown>;

    expect(parts.maxItems).toBeUndefined();
  });

  it('loadDecompositionSchema は不正な maxInitialParts を拒否する', async () => {
    const { loadDecompositionSchema } = await import('../infra/resources/schema-loader.js');

    expect(() => loadDecompositionSchema(0)).toThrow('maxInitialParts must be a positive integer: 0');
    expect(() => loadDecompositionSchema(-1)).toThrow('maxInitialParts must be a positive integer: -1');
  });

  it('loadMorePartsSchema は追加part数を制限しない', async () => {
    const { loadMorePartsSchema } = await import('../infra/resources/schema-loader.js');

    const first = loadMorePartsSchema();
    const second = loadMorePartsSchema();
    const parts = (first.properties as Record<string, unknown>).parts as Record<string, unknown>;

    expect(parts.maxItems).toBeUndefined();
    expect(first).not.toBe(second);
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
  });
});
