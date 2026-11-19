import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearTaktEnv, restoreTaktEnv, type TaktEnvSnapshot } from './helpers/taktEnv.js';

const testRoot = join(tmpdir(), `takt-refresh-interval-${randomUUID()}`);
const globalTaktDir = join(testRoot, 'global');
const globalConfigPath = join(globalTaktDir, 'config.yaml');
const projectDir = join(testRoot, 'project');
const npmPluginResolution = vi.hoisted(() => vi.fn());

vi.mock('../infra/config/paths.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    getGlobalConfigPath: () => globalConfigPath,
    getTaktDir: () => globalTaktDir,
  };
});

vi.mock('../infra/deepseek-harness/npm-plugin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/deepseek-harness/npm-plugin.js')>();
  return {
    ...actual,
    resolveDeepSeekHarnessNpmPlugins: (...args: Parameters<typeof actual.resolveDeepSeekHarnessNpmPlugins>) =>
      npmPluginResolution(...args),
  };
});

const { invalidateGlobalConfigCache } = await import('../infra/config/global/globalConfig.js');
const { resolveManagerConfig } = await import('../infra/config/managerConfig.js');
const { invalidateAllResolvedConfigCache } = await import('../infra/config/index.js');

let taktEnvSnapshot: TaktEnvSnapshot;

function writeGlobalConfig(intervalMs: number | undefined): void {
  mkdirSync(globalTaktDir, { recursive: true });
  writeFileSync(
    globalConfigPath,
    intervalMs === undefined ? 'language: en\n' : `manager:\n  refresh_interval_ms: ${intervalMs}\n`,
    'utf-8',
  );
}

function writeProjectConfig(intervalMs: number | undefined): void {
  mkdirSync(join(projectDir, '.takt'), { recursive: true });
  writeFileSync(
    join(projectDir, '.takt', 'config.yaml'),
    intervalMs === undefined ? 'language: en\n' : `manager:\n  refresh_interval_ms: ${intervalMs}\n`,
    'utf-8',
  );
}

function resolveRefreshIntervalMs(): number {
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
  return resolveManagerConfig(projectDir).refreshIntervalMs;
}

beforeEach(() => {
  taktEnvSnapshot = clearTaktEnv();
  mkdirSync(testRoot, { recursive: true });
});

afterEach(() => {
  restoreTaktEnv(taktEnvSnapshot);
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
  rmSync(testRoot, { recursive: true, force: true });
});

describe('manager refresh interval resolution', () => {
  it('defaults to 500ms when nothing is configured', () => {
    writeGlobalConfig(undefined);
    writeProjectConfig(undefined);
    expect(resolveRefreshIntervalMs()).toBe(500);
  });

  it('uses the global config value when the project does not set one', () => {
    writeGlobalConfig(2000);
    writeProjectConfig(undefined);
    expect(resolveRefreshIntervalMs()).toBe(2000);
  });

  it('prefers the project config value over the global one', () => {
    writeGlobalConfig(2000);
    writeProjectConfig(3000);
    expect(resolveRefreshIntervalMs()).toBe(3000);
  });

  it('lets TAKT_MANAGER_REFRESH_INTERVAL_MS override both config files', () => {
    writeGlobalConfig(2000);
    writeProjectConfig(3000);
    process.env.TAKT_MANAGER_REFRESH_INTERVAL_MS = '4000';
    expect(resolveRefreshIntervalMs()).toBe(4000);
  });

  it('rejects a non-numeric TAKT_MANAGER_REFRESH_INTERVAL_MS', () => {
    writeGlobalConfig(undefined);
    writeProjectConfig(undefined);
    process.env.TAKT_MANAGER_REFRESH_INTERVAL_MS = 'abc';
    expect(() => resolveRefreshIntervalMs()).toThrow('invalid manager.refresh_interval_ms');
  });

  it('rejects a fractional TAKT_MANAGER_REFRESH_INTERVAL_MS', () => {
    writeGlobalConfig(undefined);
    writeProjectConfig(undefined);
    process.env.TAKT_MANAGER_REFRESH_INTERVAL_MS = '1.5';
    expect(() => resolveRefreshIntervalMs()).toThrow('invalid manager.refresh_interval_ms');
  });

  it('rejects a TAKT_MANAGER_REFRESH_INTERVAL_MS with a unit suffix', () => {
    writeGlobalConfig(undefined);
    writeProjectConfig(undefined);
    process.env.TAKT_MANAGER_REFRESH_INTERVAL_MS = '2000ms';
    expect(() => resolveRefreshIntervalMs()).toThrow('invalid manager.refresh_interval_ms');
  });

  it('rejects a TAKT_MANAGER_REFRESH_INTERVAL_MS above the timer limit', () => {
    writeGlobalConfig(undefined);
    writeProjectConfig(undefined);
    process.env.TAKT_MANAGER_REFRESH_INTERVAL_MS = '2592000000';
    expect(() => resolveRefreshIntervalMs()).toThrow('invalid manager.refresh_interval_ms');
  });

  it('rejects a config value above the timer limit', () => {
    writeGlobalConfig(undefined);
    writeProjectConfig(2592000000);
    expect(() => resolveRefreshIntervalMs()).toThrow('invalid manager.refresh_interval_ms');
  });

  it('accepts a config value at the timer limit', () => {
    writeGlobalConfig(undefined);
    writeProjectConfig(2147483647);
    expect(resolveRefreshIntervalMs()).toBe(2147483647);
  });
});
