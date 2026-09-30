import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type IPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };
const childPath = fileURLToPath(new URL('./fixtures/update-notifier-sigint-child.mjs', import.meta.url));

describe('update notifier with real OS SIGINT', () => {
  let child: IPty | undefined;
  let root: string | undefined;
  let exitCode: number | undefined;
  let output: string;

  afterEach(async () => {
    if (child && exitCode === undefined) {
      child.kill('SIGKILL');
      await vi.waitFor(() => expect(exitCode).toBeDefined());
    }
    if (root) rmSync(root, { recursive: true, force: true });
    child = undefined;
    root = undefined;
  });

  function start(scenario: string, latest: string): string {
    root = mkdtempSync(join(process.cwd(), '.takt/update-notifier-it-'));
    const configDir = join(root, 'configstore');
    mkdirSync(configDir);
    const cache = join(configDir, 'update-notifier-takt.json');
    writeFileSync(cache, JSON.stringify({
      optOut: false, lastUpdateCheck: Date.now(),
      update: { latest, current: version, type: 'major', name: 'takt' },
    }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
      value !== undefined && !key.startsWith('npm_') && !key.startsWith('NPM_')
      && !key.startsWith('TAKT_') && !['NODE_ENV', 'NO_UPDATE_NOTIFIER'].includes(key),
    )) as Record<string, string>;
    Object.assign(env, { XDG_CONFIG_HOME: root, TAKT_CONFIG_DIR: join(root, 'global'), CI: 'false' });
    output = '';
    exitCode = undefined;
    child = spawn(process.execPath, [childPath, scenario], { env, cols: 100, rows: 30 });
    child.onData((data) => { output += data; });
    child.onExit((event) => { exitCode = event.exitCode; });
    return cache;
  }

  async function waitForEvent(type: string): Promise<void> {
    await vi.waitFor(() => {
      expect(output, output).toContain(JSON.stringify({ type }));
      expect(exitCode, output).toBeUndefined();
    }, { timeout: 5000 });
  }

  it.each([
    ['barrel', '99.0.0'],
    ['cache', '99.0.0'],
    ['cache', version],
  ])('should wait for completion after one SIGINT: %s / %s', async (scenario, latest) => {
    const cache = start(scenario, latest);
    await waitForEvent('ready');
    expect(output).not.toContain('Update available');
    if (scenario === 'cache' && latest !== version) {
      expect(JSON.parse(readFileSync(cache, 'utf8')).update).toBeUndefined();
    }
    process.kill(child!.pid, 'SIGINT');
    await waitForEvent('checkpoint');
    expect(output.match(/"type":"graceful"/g)).toHaveLength(1);
    expect(output).not.toContain('"type":"forced"');
    expect(output).not.toContain('Update available');
    child!.write('finish\n');
    await vi.waitFor(() => expect(exitCode, output).toBe(0), { timeout: 5000 });
    expect(output).toContain('"type":"completed"');
    if (scenario === 'cache' && latest !== version) {
      expect(output.match(/Update available/g)).toHaveLength(1);
      expect(output.indexOf('Update available')).toBeGreaterThan(output.indexOf('"type":"completed"'));
    } else {
      expect(output).not.toContain('Update available');
    }
  });

  it('should force exit for a second external SIGINT after the graceful checkpoint', async () => {
    start('barrel', '99.0.0');
    await waitForEvent('ready');
    process.kill(child!.pid, 'SIGINT');
    await waitForEvent('checkpoint');
    process.kill(child!.pid, 'SIGINT');
    await vi.waitFor(() => expect(exitCode, output).toBe(130), { timeout: 5000 });
    expect(output).toContain('"type":"forced"');
    expect(output).not.toContain('"type":"completed"');
  });
});
