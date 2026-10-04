import { describe, expect, it } from 'vitest';
import { runPrivateArtifactHelper } from '../shared/utils/private-artifact-helper.js';

describe('runPrivateArtifactHelper timeout', () => {
  it('should allow a child process to complete after more than five seconds', () => {
    const script = `
      setTimeout(() => process.stdout.write(process.argv[1]), 6_000);
    `;

    const output = runPrivateArtifactHelper(
      script,
      'completed',
      process.cwd(),
      'Private artifact helper failed',
    );

    expect(output).toBe('completed');
  }, 45_000);
});
