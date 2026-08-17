const ISSUE_COMMENT_FAILURE_FALLBACK = 'Issue comment command failed';
const ISSUE_COMMENT_BODY_MASK = '[comment body omitted]';

export function getIssueCommentFailureReason(error: unknown, body: string): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) {
    return ISSUE_COMMENT_FAILURE_FALLBACK;
  }

  const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
  if (stderr.length === 0) {
    return ISSUE_COMMENT_FAILURE_FALLBACK;
  }

  return body.length > 0 ? stderr.replaceAll(body, ISSUE_COMMENT_BODY_MASK) : stderr;
}
