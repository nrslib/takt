import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { packageVersion } from '../shared/package-info.js';

const { read, save } = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock('../shared/utils/updateNotifierCache.js', () => ({ readUpdateCache: read, saveUpdateCache: save }));

describe('update cache worker', () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.stubEnv('NO_UPDATE_NOTIFIER', undefined);
    process.argv = ['node', 'worker'];
    process.exitCode = undefined;
    read.mockReturnValue({ lastUpdateCheck: 0, optOut: false, custom: 'preserved' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: '99.0.0' }))));
  });
  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('saves a validated registry version and preserves unrelated cache fields', async () => {
    await import('../shared/utils/updateNotifierWorker.js');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      optOut: false, custom: 'preserved', lastUpdateCheck: expect.any(Number),
      update: expect.objectContaining({ latest: '99.0.0', name: 'takt' }),
    }));
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps the existing cache fields when the registry version is unchanged', async () => {
    read.mockReturnValue({});
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ version: packageVersion })));
    await import('../shared/utils/updateNotifierWorker.js');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      optOut: false,
      update: { latest: packageVersion, current: packageVersion, name: 'takt', type: 'latest' },
    }));
  });

  it.each(['opt-out', 'recent check', 'flag', 'environment'])('avoids fetching for %s', async (condition) => {
    if (condition === 'opt-out') read.mockReturnValue({ optOut: true });
    if (condition === 'recent check') read.mockReturnValue({ lastUpdateCheck: Date.now() });
    if (condition === 'flag') process.argv.push('--no-update-notifier');
    if (condition === 'environment') vi.stubEnv('NO_UPDATE_NOTIFIER', '');
    await import('../shared/utils/updateNotifierWorker.js');
    expect(fetch).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(['fetch', 'HTTP', 'JSON', 'version', 'save'])('reports %s failure only in the detached worker', async (failure) => {
    if (failure === 'fetch') vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    if (failure === 'HTTP') vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 503 }));
    if (failure === 'JSON') vi.mocked(fetch).mockResolvedValue(new Response('{'));
    if (failure === 'version') vi.mocked(fetch).mockResolvedValue(new Response('{"version":42}'));
    if (failure === 'save') save.mockImplementation(() => { throw new Error('EACCES'); });
    await import('../shared/utils/updateNotifierWorker.js');
    expect(process.exitCode).toBe(1);
    if (failure !== 'save') expect(save).not.toHaveBeenCalled();
  });
});
