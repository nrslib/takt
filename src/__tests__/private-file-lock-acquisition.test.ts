import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { PrivateArtifactCreationFailedError } from '../shared/utils/private-artifact-backend.js';

const write = vi.hoisted(() => vi.fn());
const failures = vi.hoisted(() => ({
  contentStage: undefined as 'open' | 'fchmod' | 'ftruncate' | 'write' | undefined,
  contentError: undefined as Error | undefined,
  closeError: undefined as Error | undefined,
  publicationError: undefined as Error | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const failContentStage = (stage: typeof failures.contentStage, descriptor: number): void => {
    if (failures.contentStage === stage && actual.fstatSync(descriptor).isFile()) {
      failures.contentStage = undefined;
      throw failures.contentError;
    }
  };
  return {
    ...actual,
    openSync(...args: Parameters<typeof actual.openSync>) {
      if (failures.contentStage === 'open' && String(args[0]).endsWith('.tmp')) {
        failures.contentStage = undefined;
        throw failures.contentError;
      }
      return actual.openSync(...args);
    },
    fchmodSync(...args: Parameters<typeof actual.fchmodSync>) {
      failContentStage('fchmod', args[0]);
      return actual.fchmodSync(...args);
    },
    ftruncateSync(...args: Parameters<typeof actual.ftruncateSync>) {
      failContentStage('ftruncate', args[0]);
      return actual.ftruncateSync(...args);
    },
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
      if (typeof args[0] === 'number') failContentStage('write', args[0]);
      return actual.writeFileSync(...args);
    },
    closeSync(...args: Parameters<typeof actual.closeSync>) {
      const closeError = actual.fstatSync(args[0]).isFile() ? failures.closeError : undefined;
      const result = actual.closeSync(...args);
      if (closeError !== undefined) {
        failures.closeError = undefined;
        throw closeError;
      }
      return result;
    },
  };
});

vi.mock('../shared/utils/private-artifact-backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/utils/private-artifact-backend.js')>();
  return {
    ...actual,
    publishPrivateArtifact(...args: Parameters<typeof actual.publishPrivateArtifact>) {
      const error = failures.publicationError;
      if (error !== undefined) {
        failures.publicationError = undefined;
        throw error;
      }
      return actual.publishPrivateArtifact(...args);
    },
  };
});

vi.mock('../shared/utils/private-file.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../shared/utils/private-file.js')>();
  return {
    ...original,
    writeNewPrivateFileWithMode: (...args: Parameters<typeof original.writeNewPrivateFileWithMode>) =>
      write(...args),
  };
});

import { PrivateFileLockAcquisitionError, runPrivateFileExclusive } from '../shared/utils/private-file-lock.js';
import { PrivateArtifactContentWriteFailedError } from '../shared/utils/private-file.js';

async function useActualPrivateFileWrite(): Promise<void> {
  const original = await vi.importActual<typeof import('../shared/utils/private-file.js')>(
    '../shared/utils/private-file.js',
  );
  write.mockImplementationOnce(original.writeNewPrivateFileWithMode);
}

describe('private file lock acquisition', () => {
  beforeEach(() => {
    write.mockReset();
    failures.contentStage = undefined;
    failures.contentError = undefined;
    failures.closeError = undefined;
    failures.publicationError = undefined;
  });

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

  it.each(['open', 'fchmod', 'ftruncate', 'write'] as const)(
    'marks ENOSPC during unpublished %s and removes the temporary lock file', async (stage) => {
      const directory = mkdtempSync(join(tmpdir(), 'takt-lock-test-'));
      await useActualPrivateFileWrite();
      const source = Object.assign(new Error(`disk full during ${stage}`), { code: 'ENOSPC', errno: -28 });
      failures.contentStage = stage;
      failures.contentError = source;
      const action = vi.fn();

      let caught: unknown;
      try {
        runPrivateFileExclusive(join(directory, 'lock'), action);
      } catch (error) {
        caught = error;
      } finally {
        const remaining = readdirSync(directory);
        rmSync(directory, { recursive: true, force: true });
        expect(remaining).toEqual([]);
      }

      expect(failures.contentStage).toBeUndefined();
      expect(caught).toBeInstanceOf(PrivateFileLockAcquisitionError);
      expect(caught).toMatchObject({ code: 'ENOSPC', errno: -28 });
      expect((caught as Error).cause).toMatchObject({
        code: 'ENOSPC', errno: -28, cause: source,
      });
      expect((caught as Error).cause).toBeInstanceOf(PrivateArtifactContentWriteFailedError);
      expect(action).not.toHaveBeenCalled();
    },
  );

  it('does not classify publication ENOSPC as an acquisition error', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-lock-test-'));
    await useActualPrivateFileWrite();
    const source = Object.assign(new Error('publication failed'), { code: 'ENOSPC' });
    failures.publicationError = source;
    const action = vi.fn();

    let caught: unknown;
    try {
      runPrivateFileExclusive(join(directory, 'lock'), action);
    } catch (error) {
      caught = error;
    } finally {
      const remaining = readdirSync(directory);
      rmSync(directory, { recursive: true, force: true });
      expect(remaining).toEqual([]);
    }

    expect(failures.publicationError).toBeUndefined();
    expect(caught).toBe(source);
    expect(action).not.toHaveBeenCalled();
  });

  it('does not classify a combined content-write and descriptor-close failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-lock-test-'));
    await useActualPrivateFileWrite();
    failures.contentStage = 'write';
    failures.contentError = Object.assign(new Error('write failed'), { code: 'ENOSPC' });
    failures.closeError = new Error('close failed');
    const action = vi.fn();

    let caught: unknown;
    try {
      runPrivateFileExclusive(join(directory, 'lock'), action);
    } catch (error) {
      caught = error;
    } finally {
      const remaining = readdirSync(directory);
      rmSync(directory, { recursive: true, force: true });
      expect(remaining).toEqual([]);
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught).not.toBeInstanceOf(PrivateFileLockAcquisitionError);
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
