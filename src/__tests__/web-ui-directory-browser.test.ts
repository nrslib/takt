import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  browseDirectory,
  parseDirectoryBrowseRequest,
} from '../features/web-ui/directory-browser.js';

describe('Web UI directory browser', () => {
  it('lists child directories without exposing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'takt-directory-browser-'));
    await mkdir(join(root, 'project'));
    await writeFile(join(root, 'notes.txt'), 'not a directory');

    const result = await browseDirectory(root);

    expect(result.path).toBe(root);
    expect(result.directories).toEqual([{ name: 'project', path: join(root, 'project') }]);
  });

  it('rejects relative paths at the HTTP input boundary', () => {
    expect(() => parseDirectoryBrowseRequest({ path: 'relative/project' }))
      .toThrow('path must be an absolute directory path');
  });

  it('caps the returned directory list before resolving entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'takt-directory-browser-limit-'));
    await Promise.all(Array.from({ length: 2_005 }, (_, index) =>
      mkdir(join(root, `directory-${String(index).padStart(4, '0')}`))));

    const result = await browseDirectory(root);

    expect(result.directories).toHaveLength(2_000);
    expect(result.directories[0]?.name).toBe('directory-0000');
    expect(result.directories.at(-1)?.name).toBe('directory-1999');
    expect(result.directories.some(({ name }) => name === 'directory-2000')).toBe(false);
  });
});
