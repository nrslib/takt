import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => ({
  files: new Set<string>(),
  links: new Map<string, string>(),
  directories: new Set<string>(),
  contents: new Map<string, string>(),
  symlink: vi.fn(),
  failRename: false,
  abortAfterBackup: undefined as AbortController | undefined,
}));

vi.mock('node:fs/promises', () => {
  const missing = (): Error => Object.assign(new Error('Not found'), { code: 'ENOENT' });
  return {
    stat: async (path: string) => {
      const target = fsState.links.get(path) ?? path;
      if (!fsState.files.has(target) && !fsState.directories.has(target)) throw missing();
      return { isFile: () => fsState.files.has(target), isDirectory: () => fsState.directories.has(target) };
    },
    access: async (path: string) => {
      if (!fsState.files.has(path) && !fsState.directories.has(path) && !fsState.links.has(path)) throw missing();
    },
    lstat: async (path: string) => {
      if (!fsState.links.has(path) && !fsState.directories.has(path) && !fsState.files.has(path)) throw missing();
      return { isSymbolicLink: () => fsState.links.has(path), isDirectory: () => fsState.directories.has(path), isFile: () => fsState.files.has(path) };
    },
    realpath: async (path: string) => {
      const target = fsState.links.get(path);
      if (target !== undefined) return target;
      if (fsState.directories.has(path) || fsState.files.has(path)) return path;
      throw missing();
    },
    mkdir: async (path: string) => { fsState.directories.add(path); },
    symlink: async (target: string, path: string, type: string) => {
      fsState.symlink(target, path, type);
      fsState.links.set(path, resolve(dirname(path), target));
    },
    readlink: async (path: string) => {
      const target = fsState.links.get(path);
      if (target === undefined) throw missing();
      return target;
    },
    writeFile: async (path: string, content: string) => { fsState.files.add(path); fsState.contents.set(path, content); },
    readFile: async (path: string) => {
      if (!fsState.contents.has(path)) throw missing();
      return fsState.contents.get(path);
    },
    rename: async (from: string, to: string) => {
      if (fsState.failRename) {
        fsState.failRename = false;
        throw Object.assign(new Error('Publication rename failed'), { code: 'EACCES' });
      }
      if (fsState.links.has(from)) {
        fsState.links.set(to, fsState.links.get(from)!);
        fsState.links.delete(from);
        if (to.endsWith('/.sdk-previous')) fsState.abortAfterBackup?.abort();
        return;
      }
      if (fsState.files.has(from)) {
        fsState.files.delete(from); fsState.files.add(to);
        fsState.contents.set(to, fsState.contents.get(from)!); fsState.contents.delete(from); return;
      }
      throw missing();
    },
    rm: async (path: string) => { fsState.links.delete(path); fsState.files.delete(path); fsState.contents.delete(path); fsState.directories.delete(path); },
    unlink: async (path: string) => { fsState.links.delete(path); fsState.files.delete(path); fsState.contents.delete(path); },
    readdir: async (path: string) => [...fsState.links.keys(), ...fsState.directories, ...fsState.files]
      .filter((entry) => dirname(entry) === path).map((entry) => entry.slice(path.length + 1)),
  };
});

import { resolveManagedNpmCommand } from '../infra/deepseek-harness/npm-command.js';

const root = '/test/node-install';
const nodePath = join(root, 'bin', 'node');
const emptyPath = join(root, 'empty');
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(() => {
  fsState.files.clear();
  fsState.links.clear();
  fsState.directories.clear();
  fsState.contents.clear();
  fsState.symlink.mockClear();
  fsState.failRename = false;
  fsState.abortAfterBackup = undefined;
});

interface ManagedGenerationModule {
  resolveManagedGeneration(root: string, options: { platform: NodeJS.Platform; signal?: AbortSignal }): Promise<string | undefined>;
  publishManagedGeneration(root: string, directory: string, options: { platform: NodeJS.Platform; signal?: AbortSignal }): Promise<void>;
  recoverManagedPublication(root: string, options: { platform: NodeJS.Platform; signal?: AbortSignal }): Promise<void>;
}

async function generationModule(): Promise<ManagedGenerationModule> {
  const modulePath = '../infra/managed-providers/generation.js';
  return await import(modulePath) as ManagedGenerationModule;
}

describe('managed generation publication on Windows', () => {
  const managedRoot = '/test/managed';
  const oldDirectory = join(managedRoot, 'sdk-old');
  const nextDirectory = join(managedRoot, 'sdk-next');
  const options = { platform: 'win32' } as const;

  beforeEach(() => {
    for (const path of [managedRoot, oldDirectory, nextDirectory]) fsState.directories.add(path);
  });

  it('publishes and resolves a managed generation through a directory junction', async () => {
    const generation = await generationModule();
    await generation.publishManagedGeneration(managedRoot, oldDirectory, options);
    expect(await generation.resolveManagedGeneration(managedRoot, options)).toBe(oldDirectory);
    expect(fsState.symlink).toHaveBeenCalled();
    for (const [target, , type] of fsState.symlink.mock.calls) {
      expect(target).toBe(oldDirectory);
      expect(type).toBe('junction');
    }
    await generation.publishManagedGeneration(managedRoot, nextDirectory, options);
    expect(await generation.resolveManagedGeneration(managedRoot, options)).toBe(nextDirectory);
    expect(fsState.directories.has(oldDirectory)).toBe(true);
  });

  it('keeps the previous generation usable after publication rename fails and recovery runs', async () => {
    const generation = await generationModule();
    await generation.publishManagedGeneration(managedRoot, oldDirectory, options);
    fsState.failRename = true;
    await expect(generation.publishManagedGeneration(managedRoot, nextDirectory, options)).rejects.toThrow('Publication rename failed');
    await generation.recoverManagedPublication(managedRoot, options);
    expect(await generation.resolveManagedGeneration(managedRoot, options)).toBe(oldDirectory);
    await generation.publishManagedGeneration(managedRoot, nextDirectory, options);
    expect(await generation.resolveManagedGeneration(managedRoot, options)).toBe(nextDirectory);
  });

  it('preserves the current generation when publication is already aborted', async () => {
    const generation = await generationModule();
    await generation.publishManagedGeneration(managedRoot, oldDirectory, options);
    const controller = new AbortController();
    controller.abort();
    await expect(generation.publishManagedGeneration(managedRoot, nextDirectory, { ...options, signal: controller.signal })).rejects.toThrow();
    await generation.recoverManagedPublication(managedRoot, options);
    expect(await generation.resolveManagedGeneration(managedRoot, options)).toBe(oldDirectory);
  });

  it('rejects publication outside the managed root without changing the current generation', async () => {
    const generation = await generationModule();
    await generation.publishManagedGeneration(managedRoot, oldDirectory, options);
    const outside = '/test/unmanaged/sdk';
    fsState.directories.add(outside);
    await expect(generation.publishManagedGeneration(managedRoot, outside, options)).rejects.toThrow();
    expect(await generation.resolveManagedGeneration(managedRoot, options)).toBe(oldDirectory);
  });

  it('restores the old junction after cancellation between the two Windows renames', async () => {
    const generation = await generationModule();
    await generation.publishManagedGeneration(managedRoot, oldDirectory, options);
    const controller = new AbortController();
    fsState.abortAfterBackup = controller;
    await expect(generation.publishManagedGeneration(managedRoot, nextDirectory, { ...options, signal: controller.signal })).rejects.toThrow();
    expect(await generation.resolveManagedGeneration(managedRoot, options)).toBe(oldDirectory);
  });

  it('makes a interrupted publication usable and restores it at the next recovery', async () => {
    const generation = await generationModule();
    fsState.links.set(join(managedRoot, '.sdk-previous'), oldDirectory);
    const pending = '.sdk-link-123-abc';
    fsState.links.set(join(managedRoot, pending), nextDirectory);
    const journal = join(managedRoot, '.sdk-publication.json');
    fsState.files.add(journal);
    fsState.contents.set(journal, JSON.stringify({ pending }));
    expect(await generation.resolveManagedGeneration(managedRoot, options)).toBe(oldDirectory);
    await generation.recoverManagedPublication(managedRoot, options);
    expect(fsState.links.get(join(managedRoot, 'sdk'))).toBe(oldDirectory);
    expect(fsState.links.has(join(managedRoot, pending))).toBe(false);
    expect(fsState.files.has(journal)).toBe(false);
  });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  vi.restoreAllMocks();
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
    await expect(resolveManagedNpmCommand({ nodePath, path: pathDir }))
      .resolves.toEqual({ command: nodePath, argsPrefix: [bundled] });
  });

  it('uses the adjacent npm symlink for a split Homebrew layout', async () => {
    const target = join('/test/homebrew', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    fsState.files.add(target);
    fsState.links.set(join(dirname(nodePath), 'npm'), target);
    await expect(resolveManagedNpmCommand({ nodePath, path: emptyPath }))
      .resolves.toEqual({ command: nodePath, argsPrefix: [target] });
  });

  it('falls back to PATH and reports when npm is absent', async () => {
    const pathDir = join(root, 'path');
    fsState.files.add(join(pathDir, 'npm'));
    await expect(resolveManagedNpmCommand({ nodePath, path: pathDir }))
      .resolves.toEqual({ command: join(pathDir, 'npm'), argsPrefix: [] });
    await expect(resolveManagedNpmCommand({ nodePath, path: emptyPath }))
      .rejects.toThrow(/npm was not found.*Add npm to PATH/u);
  });

  it('ignores empty and relative PATH entries', async () => {
    fsState.files.add(join('.', 'npm'));
    fsState.files.add(join('node_modules', '.bin', 'npm'));
    await expect(resolveManagedNpmCommand({ nodePath, path: `:node_modules/.bin:${emptyPath}:` }))
      .rejects.toThrow(/npm was not found/u);
  });

  it('uses npm-cli.js beside node.exe before the Windows PATH command', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const windowsNode = join(root, 'node.exe');
    const bundled = join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const pathDir = join(root, 'path');
    fsState.files.add(bundled);
    fsState.files.add(join(pathDir, 'npm.cmd'));
    await expect(resolveManagedNpmCommand({ nodePath: windowsNode, path: pathDir }))
      .resolves.toEqual({ command: windowsNode, argsPrefix: [bundled] });
  });

  it('resolves npm.cmd from an absolute Windows PATH entry', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const pathDir = join(root, 'path');
    const npm = join(pathDir, 'npm.cmd');
    fsState.files.add(npm);
    await expect(resolveManagedNpmCommand({ nodePath: join(root, 'node.exe'), path: pathDir }))
      .resolves.toEqual({ command: npm, argsPrefix: [] });
  });
});
