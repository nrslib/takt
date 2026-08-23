import { describe, expect, it } from 'vitest';

import {
  preparePreviousResponseContent,
  prepareReferenceContent,
} from '../core/workflow/instruction/InstructionBuilder.js';

describe('InstructionBuilder reference content', () => {
  it('keeps short reference material free of source metadata', () => {
    expect(prepareReferenceContent('短い資料', '/tmp/reference.md', 'ja')).toBe('短い資料');
  });

  it('renders a direct Japanese truncation notice without facet metadata', () => {
    const result = prepareReferenceContent('あ'.repeat(2_001), '/tmp/reference.md', 'ja');

    expect(result).toContain('...（以下省略）...');
    expect(result).toContain('判断前に次のファイルを先頭から末尾まで確認してください');
    expect(result).not.toMatch(/Knowledge|Policy|Source Path|Source:/);
  });

  it('omits source metadata when a previous response is not truncated', () => {
    const result = preparePreviousResponseContent('完了内容', '/tmp/response.md', false, 'ja');

    expect(result).toBe('完了内容');
  });
});
