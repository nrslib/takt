import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { PrivateArtifactCreationFailedError } from '../shared/utils/private-artifact-backend.js';

const write = vi.hoisted(() => vi.fn());
vi.mock('../shared/utils/private-file.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../shared/utils/private-file.js')>();
  return {
    ...original,
    writeNewPrivateFileWithMode: (...args: Parameters<typeof original.writeNewPrivateFileWithMode>) =>
      write(...args),
  };
});

import { PrivateFileLockAcquisitionError, runPrivateFileExclusive } from '../shared/utils/private-file-lock.js';

describe('private file lock acquisition', () => {
  it('marks ENOSPC during lock file creation before running the action', () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-lock-test-'));
    const source = new PrivateArtifactCreationFailedError('disk full', 'ENOSPC', -28, {});
    write.mockImplementationOnce(() => { throw source; });
    const action = vi.fn();

    let caught: unknown;
    try {
      runPrivateFileExclusive(join(directory, 'lock'), action);
    } catch (error) {
      caught = error;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    expect(caught).toBeInstanceOf(PrivateFileLockAcquisitionError);
    expect(caught).toMatchObject({ message: 'disk full', code: 'ENOSPC', errno: -28, cause: source });
    expect(action).not.toHaveBeenCalled();
  });

  it('does not mark an ENOSPC thrown after the lock is acquired', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-lock-test-'));
    const original = await vi.importActual<typeof import('../shared/utils/private-file.js')>(
      '../shared/utils/private-file.js',
    );
    write.mockImplementationOnce(original.writeNewPrivateFileWithMode);
    const actionError = Object.assign(new Error('action failed'), { code: 'ENOSPC' });

    let caught: unknown;
    try {
      runPrivateFileExclusive(join(directory, 'lock'), () => { throw actionError; });
    } catch (error) {
      caught = error;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(caught).toBe(actionError);
  });
});
