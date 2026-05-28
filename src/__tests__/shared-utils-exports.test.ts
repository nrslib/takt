import { describe, expect, it } from 'vitest';

describe('shared utils exports', () => {
  it('should keep reconnect redaction helper out of the shared utils barrel', async () => {
    const utils = await import('../shared/utils/index.js');
    expect('sanitizeSensitiveText' in utils).toBe(false);
  });
});
