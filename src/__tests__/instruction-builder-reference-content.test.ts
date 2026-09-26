import { describe, expect, it } from 'vitest';

import {
  preparePreviousResponseContent,
  prepareReferenceContent,
} from '../core/workflow/instruction/InstructionBuilder.js';

describe('InstructionBuilder reference content', () => {
  it('keeps short reference material free of source metadata', () => {
    expect(prepareReferenceContent('短い資料', '/tmp/reference.md', 'ja')).toBe('短い資料');
  });

  it('truncates long reference material and preserves the path to the full source', () => {
    const content = 'あ'.repeat(2_000) + 'SOURCE_TAIL';
    const result = prepareReferenceContent(content, '/tmp/reference.md', 'ja');

    expect(result).toContain('あ'.repeat(2_000));
    expect(result).not.toContain('SOURCE_TAIL');
    expect(result).toContain('/tmp/reference.md');
  });

  it('omits source metadata when a previous response is not truncated', () => {
    const result = preparePreviousResponseContent('完了内容', '/tmp/response.md', false, 'ja');

    expect(result).toBe('完了内容');
  });
});
