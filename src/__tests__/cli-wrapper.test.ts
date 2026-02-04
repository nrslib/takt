/**
 * Tests for the CLI wrapper URL handling.
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { posix, win32, resolve } from 'node:path';

describe('cli wrapper import URL', () => {
  it('builds a file URL for Windows paths', () => {
    const winPath = win32.join('C:\\', 'work', 'git', 'takt', 'dist', 'app', 'cli', 'index.js');
    const url = pathToFileURL(winPath).href;

    if (process.platform === 'win32') {
      expect(url).toBe('file:///C:/work/git/takt/dist/app/cli/index.js');
      return;
    }

    expect(url).toMatch(/C:%5Cwork%5Cgit%5Ctakt%5Cdist%5Capp%5Ccli%5Cindex\.js$/);
  });

  it('builds a file URL for POSIX paths', () => {
    const posixPath = posix.join('/', 'usr', 'local', 'lib', 'takt', 'dist', 'app', 'cli', 'index.js');
    const url = pathToFileURL(posixPath).href;

    expect(url).toBe('file:///usr/local/lib/takt/dist/app/cli/index.js');
  });

  it('uses pathToFileURL in the npm wrapper', async () => {
    const wrapperPath = resolve('bin', 'takt');
    const wrapperContents = await readFile(wrapperPath, 'utf8');

    expect(wrapperContents).toContain('pathToFileURL');
    expect(wrapperContents).toContain('pathToFileURL(cliPath)');
  });
});
