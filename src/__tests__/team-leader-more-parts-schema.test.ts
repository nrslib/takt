import { describe, expect, it } from 'vitest';
import { loadMorePartsSchema } from '../infra/resources/schema-loader.js';

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
