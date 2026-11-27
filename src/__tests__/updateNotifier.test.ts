import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readCache, writeCache, renameCache, spawnWorker, writeOutput } = vi.hoisted(() => ({
  readCache: vi.fn(),
  writeCache: vi.fn(),
  renameCache: vi.fn(),
  spawnWorker: vi.fn(),
  writeOutput: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  readFileSync: readCache,
  mkdirSync: vi.fn(),
  writeFileSync: writeCache,
  renameSync: renameCache,
  rmSync: vi.fn(),
  writeSync: writeOutput,
}));
vi.mock('node:child_process', () => ({ spawn: spawnWorker }));

import { runUpdateCheck } from '../app/cli/updateCheck.js';

describe('cached update notification', () => {
  const originalArgv = [...process.argv];
  const originalIsTTY = process.stdout.isTTY;
  let output: string;
  let persistedCache: string;
  let temporaryCache: string;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('XDG_CONFIG_HOME', '/isolated/update-notifier');
    vi.stubEnv('NO_UPDATE_NOTIFIER', undefined);
    process.argv = ['node', 'takt', 'list'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    output = '';
    writeOutput.mockImplementation((_fd, chunk) => { output += String(chunk); return Buffer.byteLength(String(chunk)); });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output += String(chunk); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { output += String(chunk); return true; });
    spawnWorker.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }));
    persistedCache = JSON.stringify({ lastUpdateCheck: Date.now() - 1000, optOut: false, update: { current: '1.0.0', latest: '2.0.0', name: 'takt', type: 'major' } });
    temporaryCache = '';
    readCache.mockImplementation(() => persistedCache);
    writeCache.mockImplementation((_path, content: string) => { temporaryCache = content; });
    renameCache.mockImplementation(() => { persistedCache = temporaryCache; });
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalIsTTY });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should display a newer cached version as one unboxed line during startup', async () => {
    await runUpdateCheck('1.0.0');

    const lines = stripVTControlCharacters(output).trim().split(/\r?\n/);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('2.0.0');
    expect(lines[0]).toMatch(/takt/i);
    expect(lines[0]).not.toMatch(/[─│┌┐└┘╭╮╰╯]/u);
  });

  it('should display a recent pending update once across successive startups using the same cache', async () => {
    const metadata = JSON.parse(persistedCache) as Record<string, unknown>;
    delete metadata.update;
    await runUpdateCheck('1.0.0');
    expect(stripVTControlCharacters(output).trim().split(/\r?\n/)).toHaveLength(1);
    expect(output).toContain('2.0.0');
    expect(JSON.parse(persistedCache)).toEqual(metadata);

    output = '';
    await runUpdateCheck('1.0.0');
    expect(output).toBe('');
    expect(writeCache).toHaveBeenCalledTimes(1);
    expect(spawnWorker).toHaveBeenCalledTimes(2);
  });

  it('should retain the pending notification and start the worker after a failed consumption save', async () => {
    const originalCache = persistedCache;
    writeCache.mockImplementationOnce(() => { throw new Error('EACCES'); });
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runUpdateCheck('1.0.0')).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
    expect(output).toBe('');
    expect(persistedCache).toBe(originalCache);
    expect(renameCache).not.toHaveBeenCalled();
    expect(spawnWorker).toHaveBeenCalledTimes(1);

    await runUpdateCheck('1.0.0');
    expect(output).toContain('2.0.0');
    expect(JSON.parse(persistedCache).update).toBeUndefined();
  });

  it.each([
    ['1.0.0', '1.0.0'],
    ['2.0.0', '1.0.0'],
    ['1.10.0', '1.9.0'],
    ['1.0.0', '1.0.0-rc.1'],
  ])('should not notify when current %s is not older than cached %s', async (current, latest) => {
    readCache.mockReturnValue(JSON.stringify({ update: { current, latest, name: 'takt', type: 'major' } }));
    await runUpdateCheck(current);
    expect(output).toBe('');
  });

  it.each(['1.0.1', '1.1.0', '2.0.0'])('should notify for newer version %s', async (latest) => {
    readCache.mockReturnValue(JSON.stringify({ update: { current: '1.0.0', latest, name: 'takt', type: 'major' } }));
    await runUpdateCheck('1.0.0');
    expect(stripVTControlCharacters(output)).toContain(latest);
  });

  it.each(['non-terminal', 'flag', 'environment', 'empty environment'])('should suppress notification for %s', async (condition) => {
    if (condition === 'non-terminal') Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    if (condition === 'flag') process.argv.push('--no-update-notifier');
    if (condition === 'environment') vi.stubEnv('NO_UPDATE_NOTIFIER', '1');
    if (condition === 'empty environment') vi.stubEnv('NO_UPDATE_NOTIFIER', '');

    await runUpdateCheck('1.0.0');
    expect(output).toBe('');
  });

  it.each(['{', 'null', '{}', '{"update":{"latest":42}}'])('should keep startup usable with unreadable cache data %s', async (raw) => {
    readCache.mockReturnValue(raw);
    await expect(runUpdateCheck('1.0.0')).resolves.toBeUndefined();
    expect(output).toBe('');
  });
});
