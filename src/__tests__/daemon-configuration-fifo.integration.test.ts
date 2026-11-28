import { spawnSync } from 'node:child_process';
import { mkdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { TSX_ESM_LOADER } from './helpers/typescript-source.js';

const yaml = 'language: ja\nmanager:\n  auto_run: false\n  patrol_interval: 37\n';
const configuration = { language: 'ja', manager: { auto_run: false, patrol_interval: 37 } };
const sourceUrl = new URL('../features/daemon/configuration.ts', import.meta.url).href;
const readConfiguration = `
  const { globalDaemonConfiguration, readDaemonConfiguration } = await import(process.argv[1]);
  const [scope, directory, path] = process.argv.slice(2);
  try {
    const configuration = await (scope === 'global'
      ? globalDaemonConfiguration(directory)
      : readDaemonConfiguration(path));
    process.stdout.write(JSON.stringify({ kind: 'read', configuration }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ kind: 'rejected', message: error.message }));
  }
`;

describe.skipIf(process.platform === 'win32').each(['global', 'project'] as const)('%s daemon configuration FIFO', (scope) => {
  it('reads a regular symlink target and rejects a writerless FIFO at the same target path', async () => {
    const directory = getGlobalConfigDir();
    const configDirectory = scope === 'global' ? directory : join(directory, 'repository', '.takt');
    const configPath = join(configDirectory, 'config.yaml');
    const targetPath = join(directory, 'dotfiles', 'daemon.yaml');
    await mkdir(configDirectory, { recursive: true });
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, yaml);
    await symlink(targetPath, configPath);

    function read() {
      const result = spawnSync(process.execPath, [
        '--import', TSX_ESM_LOADER, '--input-type=module', '--eval', readConfiguration,
        sourceUrl, scope, configDirectory, configPath,
      ], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
      expect(result.error, `Configuration child failed: ${result.error?.message}; ${result.stderr}`).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as unknown;
    }

    expect(read()).toEqual({ kind: 'read', configuration });
    await unlink(targetPath);
    const fifo = spawnSync('mkfifo', [targetPath], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
    expect(fifo.error).toBeUndefined();
    expect(fifo.signal).toBeNull();
    expect(fifo.status, fifo.stderr).toBe(0);
    expect((await stat(targetPath)).isFIFO()).toBe(true);

    const rejected = read();
    expect(rejected).toEqual({
      kind: 'rejected',
      message: expect.stringContaining(configPath),
    });
    expect(rejected).toMatchObject({ message: expect.stringMatching(/not a regular file|invalid private file|通常ファイル/i) });
  });
});
