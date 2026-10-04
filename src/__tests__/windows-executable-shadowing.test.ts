import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnManagedProcess } from '../shared/utils/spawn.js';

const temporaryDirectories: string[] = [];

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-windows-shadow-'));
  temporaryDirectories.push(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  writeFileSync(join(root, 'source.txt'), 'source\n');
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.runIf(process.platform === 'win32')('Windows executable shadowing', () => {
  it('should ignore taskkill.CMD in the managed process cwd', async () => {
    const root = createRepository();
    const marker = join(root, 'taskkill-cmd-marker');
    writeFileSync(join(root, 'taskkill.CMD'), [
      '@echo off',
      `echo invoked> "${marker}"`,
      'exit /b 99',
      '',
    ].join('\r\n'));
    const controller = new AbortController();
    const managed = spawnManagedProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { cwd: root, stdio: 'ignore' },
      controller.signal,
    );

    controller.abort(new Error('windows shadow test aborted'));

    await expect(managed.wait()).rejects.toThrow('windows shadow test aborted');
    expect(existsSync(marker)).toBe(false);
  });
});
