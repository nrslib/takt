import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execute = promisify(execFile);
const preload = fileURLToPath(new URL('./fixtures/update-notifier-fetch-preload.mjs', import.meta.url));

describe('update check process lifetime', () => {
  let root: string;
  let cache: string;

  beforeEach(() => {
    root = mkdtempSync(join(process.cwd(), '.takt/update-lifetime-'));
    mkdirSync(join(root, 'configstore'));
    cache = join(root, 'configstore/update-notifier-takt.json');
    writeFileSync(cache, JSON.stringify({ lastUpdateCheck: 0, optOut: false }));
  });

  afterEach(() => {
    const marker = join(root, 'fetch-started.json');
    if (existsSync(marker)) {
      const { pid } = JSON.parse(readFileSync(marker, 'utf8')) as { pid: number };
      try { process.kill(pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  async function runParent(entry: string, failure: string): Promise<{ stdout: string; stderr: string }> {
    const moduleUrl = new URL(entry, import.meta.url).href;
    const env = { ...process.env };
    delete env.NO_UPDATE_NOTIFIER;
    delete env.NODE_ENV;
    delete env.npm_config_global;
    return execute(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval',
      `const { runUpdateCheck } = await import(${JSON.stringify(moduleUrl)}); await runUpdateCheck('1.0.0'); console.log('command completed'); process.exit(0);`,
    ], {
      cwd: process.cwd(), timeout: 5000,
      env: {
        ...env, HOME: root, XDG_CONFIG_HOME: root,
        TAKT_CONFIG_DIR: join(root, 'config'), CI: 'false',
        NODE_OPTIONS: `--import=tsx --import=${preload}`,
        TAKT_TEST_UPDATE_ROOT: root, TAKT_TEST_UPDATE_FAILURE: failure,
      },
    });
  }

  it.each([
    '../app/cli/updateCheck.ts',
    '../../dist/app/cli/updateCheck.js',
  ])('should complete the command before fetch and publish the worker cache after parent exit: %s', async (entry) => {
    const parent = await runParent(entry, '');

    expect(parent.stdout).toContain('command completed');
    expect(existsSync(join(root, 'release-fetch'))).toBe(false);
    expect(JSON.parse(readFileSync(cache, 'utf8')).update).toBeUndefined();
    await vi.waitFor(() => expect(existsSync(join(root, 'fetch-started.json'))).toBe(true), { timeout: 4000 });
    const { pid } = JSON.parse(readFileSync(join(root, 'fetch-started.json'), 'utf8')) as { pid: number };
    expect(() => process.kill(pid, 0)).not.toThrow();
    writeFileSync(join(root, 'release-fetch'), '');
    await vi.waitFor(() => {
      expect(JSON.parse(readFileSync(cache, 'utf8')).update?.latest).toBe('99.0.0');
    }, { timeout: 4000 });
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 4000 });
  });

  it.each(['fetch', 'save'])('should preserve the command exit and record the failed check after %s failure', async (failure) => {
    const originalCache = JSON.parse(readFileSync(cache, 'utf8')) as { lastUpdateCheck: number };
    const parent = await runParent('../../dist/app/cli/updateCheck.js', failure);

    expect(parent.stdout).toContain('command completed');
    await vi.waitFor(() => expect(existsSync(join(root, 'fetch-started.json'))).toBe(true), { timeout: 4000 });
    const { pid } = JSON.parse(readFileSync(join(root, 'fetch-started.json'), 'utf8')) as { pid: number };
    writeFileSync(join(root, 'release-fetch'), '');
    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrow();
    }, { timeout: 4000 });
    if (failure === 'save') expect(existsSync(join(root, 'save-failed'))).toBe(true);
    const failedCache = JSON.parse(readFileSync(cache, 'utf8')) as { lastUpdateCheck: number; update?: unknown };
    expect(failedCache.lastUpdateCheck).toBeGreaterThan(originalCache.lastUpdateCheck);
    expect(failedCache.update).toBeUndefined();
  });
});
