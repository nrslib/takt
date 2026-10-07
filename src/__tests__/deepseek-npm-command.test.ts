import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => ({
  files: new Set<string>(),
  links: new Map<string, string>(),
}));

vi.mock('node:fs/promises', () => {
  const missing = (): Error => Object.assign(new Error('Not found'), { code: 'ENOENT' });
  return {
    stat: async (path: string) => {
      if (!fsState.files.has(path)) throw missing();
      return { isFile: () => true };
    },
    access: async (path: string) => {
      if (!fsState.files.has(path)) throw missing();
    },
    lstat: async (path: string) => {
      if (!fsState.links.has(path)) throw missing();
      return { isSymbolicLink: () => true };
    },
    realpath: async (path: string) => {
      const target = fsState.links.get(path);
      if (target === undefined) throw missing();
      return target;
    },
  };
});

import { resolveManagedNpmCommand } from '../infra/deepseek-harness/npm-command.js';

const root = '/test/node-install';
const nodePath = join(root, 'bin', 'node');
const emptyPath = join(root, 'empty');

beforeEach(() => {
  fsState.files.clear();
  fsState.links.clear();
});

describe('managed DeepSeek npm command resolution', () => {
  it('keeps the explicit npmPath override ahead of bundled npm', async () => {
    const bundled = join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    fsState.files.add(bundled);
    await expect(resolveManagedNpmCommand({ npmPath: '/test/fake-npm', nodePath, path: emptyPath }))
      .resolves.toEqual({ command: '/test/fake-npm', argsPrefix: [] });
  });

  it('uses the POSIX Node prefix npm CLI before PATH', async () => {
    const bundled = join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const pathDir = join(root, 'path');
    fsState.files.add(bundled);
    fsState.files.add(join(pathDir, 'npm'));
    await expect(resolveManagedNpmCommand({ nodePath, path: pathDir, platform: 'linux' }))
      .resolves.toEqual({ command: nodePath, argsPrefix: [bundled] });
  });

  it('uses the adjacent npm symlink for a split Homebrew layout', async () => {
    const target = join('/test/homebrew', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    fsState.files.add(target);
    fsState.links.set(join(dirname(nodePath), 'npm'), target);
    await expect(resolveManagedNpmCommand({ nodePath, path: emptyPath, platform: 'darwin' }))
      .resolves.toEqual({ command: nodePath, argsPrefix: [target] });
  });

  it('uses the Windows Node directory npm CLI', async () => {
    const bundled = join(root, 'bin', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    fsState.files.add(bundled);
    await expect(resolveManagedNpmCommand({ nodePath, path: emptyPath, platform: 'win32' }))
      .resolves.toEqual({ command: nodePath, argsPrefix: [bundled] });
  });

  it('falls back to PATH and reports when npm is absent', async () => {
    const pathDir = join(root, 'path');
    fsState.files.add(join(pathDir, 'npm'));
    await expect(resolveManagedNpmCommand({ nodePath, path: pathDir, platform: 'linux' }))
      .resolves.toEqual({ command: join(pathDir, 'npm'), argsPrefix: [] });
    await expect(resolveManagedNpmCommand({ nodePath, path: emptyPath, platform: 'linux' }))
      .rejects.toThrow(/npm was not found.*Add npm to PATH/u);
  });
});
