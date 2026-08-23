import { describe, expect, it } from 'vitest';
import { getIssueCommentFailureReason } from '../infra/git/issue-comment-error.js';

const ISSUE_COMMENT_ERROR_MAX_LENGTH = 16_384;

describe('getIssueCommentFailureReason performance', () => {
  it('16KiB未満の入力にあるHTTPステータスを分類する', () => {
    const input = `${'x'.repeat(ISSUE_COMMENT_ERROR_MAX_LENGTH - ' HTTP 401'.length - 1)} HTTP 401`;
    const reason = getIssueCommentFailureReason({ stderr: input }, '');

    expect(input).toHaveLength(ISSUE_COMMENT_ERROR_MAX_LENGTH - 1);
    expect(reason).toBe('authentication failed');
  });

  it('16KiB境界より後ろにあるHTTPステータスは汎用フォールバックにする', () => {
    const input = `${'x'.repeat(ISSUE_COMMENT_ERROR_MAX_LENGTH)} HTTP 401`;
    const reason = getIssueCommentFailureReason({ stderr: input }, '');

    expect(input).toHaveLength(ISSUE_COMMENT_ERROR_MAX_LENGTH + ' HTTP 401'.length);
    expect(reason).toBe('Issue comment command failed');
  });
});
