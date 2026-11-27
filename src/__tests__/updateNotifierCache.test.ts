import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { read, write, rename, remove, mkdir } = vi.hoisted(() => ({
  read: vi.fn(), write: vi.fn(), rename: vi.fn(), remove: vi.fn(), mkdir: vi.fn(),
}));
vi.mock('node:fs', () => ({ readFileSync: read, writeFileSync: write, renameSync: rename, rmSync: remove, mkdirSync: mkdir }));
import { consumeCachedNewerVersion, readUpdateCache, saveUpdateCache, updateCachePath } from '../shared/utils/updateNotifierCache.js';

describe('update notification cache', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('XDG_CONFIG_HOME', '/isolated/config');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('uses the existing configstore location', () => {
    expect(updateCachePath()).toBe('/isolated/config/configstore/update-notifier-takt.json');
  });

  it.each(['null', '[]', '{', '42'])('ignores an invalid optional cache: %s', (raw) => {
    read.mockReturnValue(raw);
    expect(readUpdateCache()).toEqual({});
    expect(consumeCachedNewerVersion('1.0.0')).toBeUndefined();
  });

  it('ignores missing cache files', () => {
    read.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(readUpdateCache()).toEqual({});
  });

  it.each([
    { update: { latest: 'bad\nversion' } },
    { update: null },
    { update: { latest: '2.0.0' }, optOut: true },
  ])('does not notify from invalid or disabled cache data: %j', (cache) => {
    read.mockReturnValue(JSON.stringify(cache));
    expect(consumeCachedNewerVersion('1.0.0')).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });

  it('publishes a complete cache by renaming an adjacent temporary file', () => {
    const cache = { lastUpdateCheck: 123, optOut: false, update: { latest: '2.0.0' } };
    saveUpdateCache(cache);
    const temporary = write.mock.calls[0]![0] as string;
    expect(temporary.startsWith(`${updateCachePath()}.`)).toBe(true);
    expect(JSON.parse(write.mock.calls[0]![1] as string)).toEqual(cache);
    expect(rename).toHaveBeenCalledWith(temporary, updateCachePath());
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(rename.mock.invocationCallOrder[0]!);
    expect(remove).toHaveBeenCalledWith(temporary, { force: true });
  });

  it('does not replace the existing cache when the write fails', () => {
    write.mockImplementation(() => { throw new Error('EACCES'); });
    expect(() => saveUpdateCache({ lastUpdateCheck: 123 })).toThrow();
    expect(rename).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
  });

  it('consumes only the newer update while preserving the check timestamp and other fields', () => {
    const metadata = { lastUpdateCheck: Date.now() - 1000, optOut: false, custom: { retained: true } };
    read.mockReturnValue(JSON.stringify({ ...metadata, update: { latest: '2.0.0' } }));

    expect(consumeCachedNewerVersion('1.0.0')).toBe('2.0.0');
    expect(read).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0]![1] as string)).toEqual(metadata);
    expect(rename).toHaveBeenCalled();
  });

  it('propagates a failed consumption without replacing the pending cache', () => {
    read.mockReturnValue(JSON.stringify({ lastUpdateCheck: 123, update: { latest: '2.0.0' } }));
    write.mockImplementation(() => { throw new Error('EACCES'); });

    expect(() => consumeCachedNewerVersion('1.0.0')).toThrow();
    expect(rename).not.toHaveBeenCalled();
    expect(readUpdateCache().update).toEqual({ latest: '2.0.0' });
  });
});
