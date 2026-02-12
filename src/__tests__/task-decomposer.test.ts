import { describe, it, expect } from 'vitest';
import { parseParts } from '../core/piece/engine/task-decomposer.js';

describe('parseParts', () => {
  it('最後のjsonコードブロックをパースする', () => {
    const content = [
      '説明',
      '```json',
      '[{"id":"old","title":"old","instruction":"old"}]',
      '```',
      '最終案',
      '```json',
      '[{"id":"a","title":"A","instruction":"Do A"},{"id":"b","title":"B","instruction":"Do B","timeout_ms":1200}]',
      '```',
    ].join('\n');

    const result = parseParts(content, 3);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 'a',
      title: 'A',
      instruction: 'Do A',
      timeoutMs: undefined,
    });
    expect(result[1]!.timeoutMs).toBe(1200);
  });

  it('jsonコードブロックがない場合はエラー', () => {
    expect(() => parseParts('no json', 3)).toThrow(
      'Team leader output must include a ```json ... ``` block',
    );
  });

  it('max_partsを超えたらエラー', () => {
    const content = '```json\n[{"id":"a","title":"A","instruction":"Do A"},{"id":"b","title":"B","instruction":"Do B"}]\n```';

    expect(() => parseParts(content, 1)).toThrow(
      'Team leader produced too many parts: 2 > 1',
    );
  });

  it('必須フィールドが不足したらエラー', () => {
    const content = '```json\n[{"id":"a","title":"A"}]\n```';

    expect(() => parseParts(content, 3)).toThrow(
      'Part[0] "instruction" must be a non-empty string',
    );
  });

  it('jsonコードブロックが配列でない場合はエラー', () => {
    const content = '```json\n{"not":"array"}\n```';

    expect(() => parseParts(content, 3)).toThrow(
      'Team leader JSON must be an array',
    );
  });

  it('空配列の場合はエラー', () => {
    const content = '```json\n[]\n```';

    expect(() => parseParts(content, 3)).toThrow(
      'Team leader JSON must contain at least one part',
    );
  });

  it('重複したpart idがある場合はエラー', () => {
    const content = [
      '```json',
      '[{"id":"dup","title":"A","instruction":"Do A"},{"id":"dup","title":"B","instruction":"Do B"}]',
      '```',
    ].join('\n');

    expect(() => parseParts(content, 3)).toThrow('Duplicate part id: dup');
  });
});
