import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isDirectEntrypoint } from '../shared/utils/entrypoint.js';

describe('isDirectEntrypoint', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function createTempFile(name: string): string {
    tempDir ??= mkdtempSync(join(tmpdir(), 'takt-entrypoint-'));
    const filePath = join(tempDir, name);
    writeFileSync(filePath, '', 'utf-8');
    return filePath;
  }

  it('returns true for the direct entrypoint path', () => {
    const entrypoint = createTempFile('entrypoint.js');

    expect(isDirectEntrypoint(pathToFileURL(entrypoint).href, ['node', entrypoint])).toBe(true);
  });

  it('returns true for a symlink to the entrypoint path', () => {
    const entrypoint = createTempFile('entrypoint.js');
    const linkedEntrypoint = join(tempDir!, 'linked-entrypoint.js');
    symlinkSync(entrypoint, linkedEntrypoint);

    expect(isDirectEntrypoint(pathToFileURL(entrypoint).href, ['node', linkedEntrypoint])).toBe(true);
  });

  it('returns false for another path', () => {
    const entrypoint = createTempFile('entrypoint.js');
    const otherFile = createTempFile('other.js');

    expect(isDirectEntrypoint(pathToFileURL(entrypoint).href, ['node', otherFile])).toBe(false);
  });

  it('returns false when argv does not include an entrypoint path', () => {
    const entrypoint = createTempFile('entrypoint.js');

    expect(isDirectEntrypoint(pathToFileURL(entrypoint).href, ['node'])).toBe(false);
  });
});
