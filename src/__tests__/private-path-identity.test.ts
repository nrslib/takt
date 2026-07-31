import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const injectedRootAlias = vi.hoisted(() => ({
  path: '',
  fixturePath: '',
  targetPath: '',
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    lstatSync(...args: Parameters<typeof actual.lstatSync>) {
      if (String(args[0]) === injectedRootAlias.path) {
        return actual.lstatSync(injectedRootAlias.fixturePath);
      }
      return actual.lstatSync(...args);
    },
    realpathSync(...args: Parameters<typeof actual.realpathSync>) {
      if (String(args[0]) === injectedRootAlias.path) {
        return injectedRootAlias.targetPath;
      }
      return actual.realpathSync(...args);
    },
  };
});

import { assertSafePath } from '../shared/utils/private-path-identity.js';

describe('private artifact path identity', () => {
  const roots: string[] = [];

  afterEach(() => {
    injectedRootAlias.path = '';
    injectedRootAlias.fixturePath = '';
    injectedRootAlias.targetPath = '';
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should accept a filesystem root alias while still rejecting a symlink below it', () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-private-root-alias-'));
    roots.push(root);
    const targetRoot = join(root, 'target');
    const aliasFixture = join(root, 'alias');
    const safeDirectory = join(targetRoot, 'safe');
    const outsideDirectory = join(root, 'outside');
    mkdirSync(safeDirectory, { recursive: true });
    mkdirSync(outsideDirectory);
    symlinkSync(targetRoot, aliasFixture, 'dir');
    symlinkSync(outsideDirectory, join(targetRoot, 'linked'), 'dir');

    injectedRootAlias.path = '/takt-private-root-alias';
    injectedRootAlias.fixturePath = aliasFixture;
    injectedRootAlias.targetPath = targetRoot;

    expect(() => assertSafePath('/takt-private-root-alias/safe', true)).not.toThrow();
    expect(() => assertSafePath('/takt-private-root-alias/linked', true)).toThrow(/symlink/);
  });
});
