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
    vi.stubEnv('NODE_ENV', undefined);
    vi.stubEnv('CI', 'false');
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
    const events: string[] = [];
    save.mockImplementation(() => { events.push('save'); });
    vi.mocked(fetch).mockImplementation(async () => {
      events.push('fetch');
      return new Response(JSON.stringify({ version: '99.0.0' }));
    });
    await import('../shared/utils/updateNotifierWorker.js');
    expect(events).toEqual(['save', 'fetch', 'save']);
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

  it.each(['opt-out', 'recent check', 'flag', 'environment', 'test environment', 'CI'])('avoids fetching for %s', async (condition) => {
    if (condition === 'opt-out') read.mockReturnValue({ optOut: true });
    if (condition === 'recent check') read.mockReturnValue({ lastUpdateCheck: Date.now() });
    if (condition === 'flag') process.argv.push('--no-update-notifier');
    if (condition === 'environment') vi.stubEnv('NO_UPDATE_NOTIFIER', '');
    if (condition === 'test environment') vi.stubEnv('NODE_ENV', 'test');
    if (condition === 'CI') vi.stubEnv('CI', 'true');
    await import('../shared/utils/updateNotifierWorker.js');
    expect(fetch).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(['false', '0'])('checks for updates when CI=%s', async (value) => {
    vi.stubEnv('CI', value);
    await import('../shared/utils/updateNotifierWorker.js');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(['fetch', 'HTTP', 'JSON', 'version', 'save'])('reports %s failure only in the detached worker', async (failure) => {
    if (failure === 'fetch') vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    if (failure === 'HTTP') vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 503 }));
    if (failure === 'JSON') vi.mocked(fetch).mockResolvedValue(new Response('{'));
    if (failure === 'version') vi.mocked(fetch).mockResolvedValue(new Response('{"version":42}'));
    if (failure === 'save') {
      save.mockImplementationOnce(() => {});
      save.mockImplementationOnce(() => { throw new Error('EACCES'); });
    }
    await import('../shared/utils/updateNotifierWorker.js');
    expect(process.exitCode).toBe(1);
    expect(save).toHaveBeenCalledTimes(failure === 'save' ? 2 : 1);
    expect(save.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      optOut: false, custom: 'preserved', lastUpdateCheck: expect.any(Number),
    }));
  });

  it('does not fetch when it cannot persist the check time', async () => {
    save.mockImplementation(() => { throw new Error('EACCES'); });
    await import('../shared/utils/updateNotifierWorker.js');
    expect(fetch).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it('throttles a later worker after a registry failure', async () => {
    let persisted: Record<string, unknown> = { lastUpdateCheck: 0, optOut: false };
    read.mockImplementation(() => persisted);
    save.mockImplementation((value) => { persisted = value as Record<string, unknown>; });
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));

    await import('../shared/utils/updateNotifierWorker.js');
    expect(persisted.lastUpdateCheck).toEqual(expect.any(Number));
    expect(persisted.update).toBeUndefined();

    vi.resetModules();
    process.exitCode = undefined;
    await import('../shared/utils/updateNotifierWorker.js');
    expect(fetch).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });
});
