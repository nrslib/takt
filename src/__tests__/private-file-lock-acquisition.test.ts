import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const write = vi.hoisted(() => vi.fn());
vi.mock('../shared/utils/private-file.js', async (original) => ({
  ...await original<typeof import('../shared/utils/private-file.js')>(),
  writeNewPrivateFileWithMode: write,
}));
import { PrivateFileLockAcquisitionError, runPrivateFileExclusive } from '../shared/utils/private-file-lock.js';
import { PrivateArtifactContentWriteFailedError } from '../shared/utils/private-file.js';
const directories: string[] = [];
afterEach(() => { write.mockReset(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
describe('private lock acquisition failures', () => {
  it.each(['creation', 'content'] as const)('classifies unpublished ENOSPC at %s and does not run the action', (stage) => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-private-lock-'));
    directories.push(directory);
    const source = stage === 'content' ? new PrivateArtifactContentWriteFailedError('disk full', -28, {})
      : Object.assign(new Error('disk full'), { code: 'ENOSPC', errno: -28 });
    write.mockImplementation(() => { throw source; });
    const action = vi.fn();
    expect(() => runPrivateFileExclusive(join(directory, 'lock'), action)).toThrow(PrivateFileLockAcquisitionError);
    expect(action).not.toHaveBeenCalled();
    expect(readdirSync(directory)).toEqual([]);
  });
  it('preserves unrelated acquisition failures', () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-private-lock-'));
    directories.push(directory);
    const source = Object.assign(new Error('denied'), { code: 'EACCES' });
    write.mockImplementation(() => { throw source; });
    expect(() => runPrivateFileExclusive(join(directory, 'lock'), () => 42)).toThrow(source);
  });
});
