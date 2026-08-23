import { describe, expect, it } from 'vitest';
import { getIssueCommentFailureReason } from '../infra/git/issue-comment-error.js';

describe('getIssueCommentFailureReason performance', () => {
  it('16KiBの敵対的なstatus入力を短時間で処理する', () => {
    getIssueCommentFailureReason({ stderr: 'permission denied' }, '');

    const input = `status${' '.repeat(16_384 - 'status'.length - 2)}xx`;
    const startedAt = performance.now();
    const reason = getIssueCommentFailureReason({ stderr: input }, '');
    const elapsedMs = performance.now() - startedAt;

    expect(input).toHaveLength(16_384);
    expect(reason).toBe('Issue comment command failed');
    expect(elapsedMs).toBeLessThan(200);
  });
});
