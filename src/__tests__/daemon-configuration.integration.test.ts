import { chmod, lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { globalDaemonConfiguration, readDaemonConfiguration } from '../features/daemon/configuration.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { readEntirePrivateFile, readPrivateFile } from '../infra/daemon/privateFile.js';

const resolution = vi.hoisted(() => ({
  path: undefined as string | undefined,
  before: undefined as (() => Promise<void>) | undefined,
  afterFailure: undefined as (() => Promise<void>) | undefined,
  beforeLstat: undefined as (() => Promise<void>) | undefined,
  events: [] as string[],
  errors: [] as unknown[],
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === resolution.path) await resolution.beforeLstat?.();
      return fs.lstat(...args);
    },
    realpath: async (...args: Parameters<typeof fs.realpath>) => {
      if (args[0] !== resolution.path) return fs.realpath(...args);
      resolution.events.push('realpath');
      await resolution.before?.();
      try {
        const path = await fs.realpath(...args);
        resolution.events.push('resolved');
        return path;
      } catch (error) {
        resolution.events.push('failed');
        resolution.errors.push(error);
        await resolution.afterFailure?.();
        throw error;
      }
    },
  };
});
afterEach(() => {
  resolution.path = undefined;
  resolution.before = undefined;
  resolution.afterFailure = undefined;
  resolution.beforeLstat = undefined;
  resolution.events.length = 0;
  resolution.errors.length = 0;
});

const capacity = 256 * 1024;
const yaml = 'language: ja\nmanager:\n  auto_run: false\n  patrol_interval: 37\n';
const configuration = { language: 'ja', manager: { auto_run: false, patrol_interval: 37 } };

function yamlWithBytes(size: number): string {
  const prefix = `${yaml}#`;
  const padding = size - Buffer.byteLength(prefix);
  return `${prefix}${'あ'.repeat(Math.floor(padding / 3))}${'x'.repeat(padding % 3)}`;
}

describe.each(['global', 'project'] as const)('%s daemon configuration', (scope) => {
  let configDirectory: string;
  let configPath: string;
  let targetPath: string;

  beforeEach(async () => {
    const directory = getGlobalConfigDir();
    configDirectory = scope === 'global' ? directory : join(directory, 'repository', '.takt');
    configPath = join(configDirectory, 'config.yaml');
    targetPath = join(directory, 'dotfiles', 'daemon.yaml');
    await mkdir(configDirectory, { recursive: true });
    await mkdir(dirname(targetPath), { recursive: true });
  });

  function read() {
    return scope === 'global' ? globalDaemonConfiguration(configDirectory) : readDaemonConfiguration(configPath);
  }

  it('reads an ordinary configuration file', async () => {
    await writeFile(configPath, yaml);

    expect(await read()).toEqual(configuration);
  });

  it.each([1, 2, 3])('uses defaults when an ordinary file disappears before realpath (attempt %i)', async () => {
    await writeFile(configPath, yaml);
    resolution.path = configPath;
    expect(await read()).toEqual(configuration);
    expect(resolution.events).toEqual(['realpath', 'resolved']);
    resolution.events.length = 0;
    resolution.before = async () => {
      await rename(configPath, `${configPath}.old`);
      resolution.events.push('renamed');
    };

    const result = await read().then(value => ({ value }), (error: unknown) => ({ error }));

    expect(resolution.events).toEqual(['realpath', 'renamed', 'failed']);
    expect(resolution.errors).toEqual([expect.objectContaining({ code: 'ENOENT', syscall: 'realpath', path: configPath })]);
    expect(result).toEqual({ value: {} });
  });

  it('propagates realpath errors other than missing files', async () => {
    await writeFile(configPath, yaml);
    resolution.path = configPath;
    const error = Object.assign(new Error('configuration realpath denied'), { code: 'EACCES' });
    resolution.before = async () => { throw error; };

    await expect(read()).rejects.toBe(error);
    expect(resolution.events).toEqual(['realpath']);
  });

  it.each([1, 2, 3])('uses defaults when the configuration symlink disappears before realpath (attempt %i)', async () => {
    await writeFile(targetPath, yaml);
    await symlink(targetPath, configPath, 'file');
    resolution.path = configPath;
    expect(await read()).toEqual(configuration);
    expect(resolution.events).toEqual(['realpath', 'resolved']);
    resolution.events.length = 0;
    const backupPath = `${configPath}.old`;
    resolution.before = async () => {
      await rename(configPath, backupPath);
      resolution.events.push('renamed');
    };

    const result = await read().then(value => ({ value }), (error: unknown) => ({ error }));

    expect(resolution.events).toEqual(['realpath', 'renamed', 'failed']);
    expect(resolution.errors).toEqual([expect.objectContaining({ code: 'ENOENT', syscall: 'realpath', path: configPath })]);
    expect((await lstat(backupPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(backupPath)).toBe(targetPath);
    expect(await readFile(targetPath, 'utf8')).toBe(yaml);
    await expect(lstat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result).toEqual({ value: {} });
  });

  it('propagates a non-missing error when rechecking a symlink after realpath fails', async () => {
    await writeFile(targetPath, yaml);
    await symlink(targetPath, configPath, 'file');
    resolution.path = configPath;
    const error = Object.assign(new Error('configuration lstat denied'), { code: 'EACCES' });
    resolution.before = async () => {
      await rename(configPath, `${configPath}.old`);
      resolution.events.push('renamed');
      resolution.beforeLstat = async () => {
        resolution.events.push('recheck');
        throw error;
      };
    };

    await expect(read()).rejects.toBe(error);
    expect(resolution.events).toEqual(['realpath', 'renamed', 'failed', 'recheck']);
    expect(resolution.errors).toEqual([expect.objectContaining({ code: 'ENOENT', syscall: 'realpath', path: configPath })]);
  });

  it.each([1, 2, 3])('uses defaults when a regular file returns after realpath fails for either initial entry (attempt %i)', async () => {
    const restoredYaml = 'language: en\nmanager:\n  auto_run: true\n  patrol_interval: 19\n';
    const backupPath = `${configPath}.old`;
    const results: unknown[] = [];
    await writeFile(targetPath, yaml);
    resolution.path = configPath;

    for (const initial of ['file', 'symlink'] as const) {
      if (initial === 'file') await writeFile(configPath, yaml);
      else await symlink(targetPath, configPath, 'file');
      resolution.before = async () => {
        await rename(configPath, backupPath);
        resolution.events.push('renamed');
      };
      resolution.afterFailure = async () => {
        await writeFile(configPath, restoredYaml);
        resolution.events.push('restored');
        resolution.beforeLstat = async () => { resolution.events.push('recheck'); };
      };

      const result = await read().then(value => ({ value }), (error: unknown) => ({ error }));

      expect(resolution.events).toEqual(['realpath', 'renamed', 'failed', 'restored', ...(initial === 'symlink' ? ['recheck'] : [])]);
      expect(resolution.errors).toEqual([expect.objectContaining({ code: 'ENOENT', syscall: 'realpath', path: configPath })]);
      resolution.beforeLstat = undefined;
      expect((await lstat(configPath)).isFile()).toBe(true);
      expect(await readFile(configPath, 'utf8')).toBe(restoredYaml);
      expect((await lstat(backupPath)).isSymbolicLink()).toBe(initial === 'symlink');
      expect(await readFile(targetPath, 'utf8')).toBe(yaml);
      results.push({ initial, result });
      await unlink(configPath);
      await unlink(backupPath);
      resolution.events.length = 0;
      resolution.errors.length = 0;
    }

    expect(results).toEqual([
      { initial: 'file', result: { value: {} } },
      { initial: 'symlink', result: { value: {} } },
    ]);
  });

  it('reads configuration through an absolute symlink to a readable 0644 file', async () => {
    await writeFile(targetPath, yaml, { mode: 0o644 });
    await chmod(targetPath, 0o644);
    await symlink(targetPath, configPath, 'file');

    expect(await read()).toEqual(configuration);
  });

  it('resolves a relative symlink from the configuration directory', async () => {
    await writeFile(targetPath, yaml);
    await symlink(relative(configDirectory, targetPath), configPath, 'file');

    expect(await read()).toEqual(configuration);
  });

  it('reports the configuration path and a broken symlink instead of using defaults', async () => {
    await symlink(targetPath, configPath, 'file');

    await expect(read()).rejects.toThrow(expect.objectContaining({
      message: expect.stringContaining(configPath),
    }));
    await expect(read()).rejects.toThrow(/broken|dangling|リンク切れ/i);
  });

  it('rejects a directory symlink with the configuration path and file type cause', async () => {
    await mkdir(targetPath);
    await symlink(targetPath, configPath, 'dir');

    await expect(read()).rejects.toThrow(expect.objectContaining({
      message: expect.stringContaining(configPath),
    }));
    await expect(read()).rejects.toThrow(/regular file|not a file|directory|invalid private file|通常ファイル|ディレクトリ/i);
  });

  it('accepts a symlink target at the 262144 byte limit', async () => {
    const content = yamlWithBytes(capacity);
    await writeFile(targetPath, content);
    await symlink(targetPath, configPath, 'file');

    expect(Buffer.byteLength(content)).toBe(capacity);
    expect(await read()).toEqual(configuration);
  });

  it('rejects a symlink target one byte over the limit with the size cause', async () => {
    const content = yamlWithBytes(capacity + 1);
    await writeFile(targetPath, content);
    await symlink(targetPath, configPath, 'file');

    expect(Buffer.byteLength(content)).toBe(capacity + 1);
    await expect(read()).rejects.toThrow(/oversized|exceeds capacity|too large|サイズ|上限/i);
  });

  it('uses defaults when the configuration file is absent', async () => {
    expect(await read()).toEqual({});
  });

  it('uses defaults when the configuration parent directory is absent', async () => {
    const missingDirectory = join(configDirectory, 'missing');

    const result = scope === 'global'
      ? await globalDaemonConfiguration(missingDirectory)
      : await readDaemonConfiguration(join(missingDirectory, 'config.yaml'));

    expect(result).toEqual({});
  });

  it('rejects malformed YAML in an ordinary configuration file', async () => {
    await writeFile(configPath, 'manager: [\n');

    await expect(read()).rejects.toThrow();
  });

  it('rejects invalid schema values in an ordinary configuration file', async () => {
    await writeFile(configPath, 'manager:\n  auto_run: invalid\n');

    await expect(read()).rejects.toThrow();
  });
});

describe('private readers outside daemon configuration', () => {
  it.each(['bounded', 'entire'] as const)('keeps the %s private reader from following symlinks', async (kind) => {
    const directory = getGlobalConfigDir();
    const target = join(directory, 'private-data');
    const link = join(directory, 'private-link');
    await writeFile(target, 'private data');
    await symlink(target, link, 'file');
    const read = (path: string) => kind === 'bounded' ? readPrivateFile(path, 1024) : readEntirePrivateFile(path);

    expect((await read(target))?.toString('utf8')).toBe('private data');
    await expect(read(link)).rejects.toThrow();
  });
});
