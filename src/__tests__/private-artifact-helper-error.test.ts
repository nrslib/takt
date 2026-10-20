import { describe, expect, it } from 'vitest';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { PrivateArtifactHelperError, runPrivateArtifactHelper } from '../shared/utils/private-artifact-helper.js';
import { createPrivateArtifact, PrivateArtifactCreationFailedError } from '../shared/utils/private-artifact-backend.js';

describe('runPrivateArtifactHelper failure metadata', () => {
  it('preserves a child errno while keeping the human-readable message', () => {
    const script = `
      process.stderr.write('disk full while opening artifact');
      process.stdout.write(JSON.stringify({ code: 'ENOSPC', errno: -28 }));
      process.exitCode = 1;
    `;

    let caught: unknown;
    try {
      runPrivateArtifactHelper(script, '', process.cwd(), 'fallback');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PrivateArtifactHelperError);
    expect(caught).toMatchObject({ message: 'disk full while opening artifact', code: 'ENOSPC', errno: -28 });
  });

  it('does not infer errno from a legacy stderr string', () => {
    const script = `
      process.stderr.write('ENOSPC: disk full');
      process.exitCode = 1;
    `;

    let caught: unknown;
    try {
      runPrivateArtifactHelper(script, '', process.cwd(), 'fallback');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PrivateArtifactHelperError);
    expect(caught).toMatchObject({ message: 'ENOSPC: disk full', code: undefined, errno: undefined });
  });

  it.skipIf(process.platform === 'win32')('preserves a real filesystem errno from the creator child', () => {
    const parent = process.cwd();
    let caught: unknown;
    try {
      createPrivateArtifact(parent, join(parent, 'a'.repeat(300)), statSync(parent), 'file', 0o600);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PrivateArtifactCreationFailedError);
    expect(caught).toMatchObject({ code: 'ENAMETOOLONG', errno: expect.any(Number) });
  });
});
