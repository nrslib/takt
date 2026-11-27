import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManagerWorkspaceAccess } from '../features/manager/workspaceAccess.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

it('marks a registered path below a regular file as missing using realpath', () => {
  const root = mkdtempSync(join(tmpdir(), 'takt-manager-workspace-not-directory-'));
  temporaryDirectories.push(root);
  const file = join(root, 'file.txt');
  const registeredDirectory = join(file, 'sub', 'repository');
  writeFileSync(file, '');

  expect(resolveManagerWorkspaceAccess('conversation', [registeredDirectory])).toEqual({
    access: { ownerId: 'conversation', directories: [] },
    missingDirectories: [registeredDirectory],
  });
});
