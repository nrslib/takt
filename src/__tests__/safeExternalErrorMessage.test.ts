import { describe, expect, it } from 'vitest';
import { safeExternalErrorMessage } from '../shared/utils/safeExternalErrorMessage.js';

describe('safeExternalErrorMessage', () => {
  it('preserves the stable external error categories', () => {
    expect(safeExternalErrorMessage(new Error('EACCES: /Users/jane/report.md'))).toBe(
      'permission denied',
    );
    expect(safeExternalErrorMessage(new Error('ENOENT: /Users/jane/report.md'))).toBe(
      'not found',
    );
  });

  it('composes sensitive text redaction with path masking', () => {
    expect(safeExternalErrorMessage(new Error(
      'api_key=plain-secret Evidence: /Users/jane/report.md',
    ))).toBe('api_key=[REDACTED] Evidence: [path]');
  });

  it('masks representative absolute paths in external errors', () => {
    expect(safeExternalErrorMessage(new Error('POSIX: /Users/jane/report.md'))).toBe(
      'POSIX: [path]',
    );
    expect(safeExternalErrorMessage(new Error('Windows: C:/Users/jane/report.md'))).toBe(
      'Windows: [path]',
    );
    expect(safeExternalErrorMessage(new Error('Home: ~/repo/report.md'))).toBe(
      'Home: [path]',
    );
  });
});
