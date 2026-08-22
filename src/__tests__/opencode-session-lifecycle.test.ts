import { describe, expect, it, vi } from 'vitest';
import { createOpenCodeSessionLifecycle } from '../infra/opencode/session-lifecycle.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('OpenCode session lifecycle', () => {
  it('does not abort a session after idle was confirmed', async () => {
    const abort = vi.fn();
    const lifecycle = createOpenCodeSessionLifecycle({
      client: { session: { abort } },
      sessionId: 'idle-session',
      directory: '/workspace',
      abortTimeoutMs: 50,
      invalidateServer: vi.fn(),
    });

    lifecycle.markPromptSent();
    lifecycle.confirmIdle();

    await expect(lifecycle.stopServerSessionOnce()).resolves.toEqual({ ok: true });
    expect(abort).not.toHaveBeenCalled();
  });

  it('waits for the one server abort and shares the in-flight promise', async () => {
    const aborted = deferred<{ data: true }>();
    const abort = vi.fn(() => aborted.promise);
    const lifecycle = createOpenCodeSessionLifecycle({
      client: { session: { abort } },
      sessionId: 'active-session',
      directory: '/workspace',
      abortTimeoutMs: 50,
      invalidateServer: vi.fn(),
    });
    lifecycle.markPromptSent();

    const first = lifecycle.stopServerSessionOnce();
    const second = lifecycle.stopServerSessionOnce();

    expect(first).toBe(second);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(
      { sessionID: 'active-session', directory: '/workspace' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    aborted.resolve({ data: true });
    await expect(first).resolves.toEqual({ ok: true });
  });

  it.each([
    [{ data: false }],
    [{ error: { message: 'abort rejected' } }],
  ])('fails closed and invalidates the server for unsuccessful abort responses', async (response) => {
    const invalidateServer = vi.fn();
    const abort = vi.fn().mockResolvedValue(response);
    const lifecycle = createOpenCodeSessionLifecycle({
      client: { session: { abort } },
      sessionId: 'active-session',
      directory: '/workspace',
      abortTimeoutMs: 50,
      invalidateServer,
    });
    lifecycle.markPromptSent();

    await expect(lifecycle.stopServerSessionOnce()).resolves.toMatchObject({ ok: false });
    expect(invalidateServer).toHaveBeenCalledTimes(1);
  });

  it('fails closed when abort rejects without exposing provider URL, session, directory, or authorization', async () => {
    const invalidateServer = vi.fn();
    const secret = `Authorization: Bearer ${'x'.repeat(240)}`;
    const sessionId = 'secret-session';
    const directory = '/workspace/private/project';
    const providerUrl = `http://127.0.0.1:4096/session/${sessionId}`;
    const lifecycle = createOpenCodeSessionLifecycle({
      client: {
        session: {
          abort: vi.fn().mockRejectedValue(
            new Error(`request failed at ${providerUrl} for ${sessionId} in ${directory}; ${secret}`),
          ),
        },
      },
      sessionId,
      directory,
      abortTimeoutMs: 50,
      invalidateServer,
    });
    lifecycle.markPromptSent();

    const result = await lifecycle.stopServerSessionOnce();

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error('expected abort failure');
    expect(result.error.message).toContain('request failed');
    expect(result.error.message).toContain('[REDACTED]');
    expect(result.error.message).not.toContain(providerUrl);
    expect(result.error.message).not.toContain(sessionId);
    expect(result.error.message).not.toContain(directory);
    expect(result.error.message).not.toContain('http://');
    expect(result.error.message).not.toContain('x'.repeat(20));
    expect(result.error.message.length).toBeLessThanOrEqual(200);
    expect(invalidateServer).toHaveBeenCalledWith(result.error);
  });

  it('times out a hanging abort, cancels its cleanup signal, and invalidates the server', async () => {
    let cleanupSignal: AbortSignal | undefined;
    const invalidateServer = vi.fn();
    const abort = vi.fn((_parameters: unknown, options: { signal: AbortSignal }) => {
      cleanupSignal = options.signal;
      return new Promise<{ data: true }>(() => {});
    });
    const lifecycle = createOpenCodeSessionLifecycle({
      client: { session: { abort } },
      sessionId: 'active-session',
      directory: '/workspace',
      abortTimeoutMs: 5,
      invalidateServer,
    });
    lifecycle.markPromptSent();

    const result = await lifecycle.stopServerSessionOnce();

    expect(result).toMatchObject({ ok: false });
    expect(cleanupSignal?.aborted).toBe(true);
    expect(invalidateServer).toHaveBeenCalledTimes(1);
  });

  it('uses a cleanup signal that remains independent after the external signal is aborted', async () => {
    const externalController = new AbortController();
    externalController.abort();
    let cleanupSignal: AbortSignal | undefined;
    const abort = vi.fn((_parameters: unknown, options: { signal: AbortSignal }) => {
      cleanupSignal = options.signal;
      return Promise.resolve({ data: true as const });
    });
    const lifecycle = createOpenCodeSessionLifecycle({
      client: { session: { abort } },
      sessionId: 'active-session',
      directory: '/workspace',
      abortTimeoutMs: 50,
      invalidateServer: vi.fn(),
    });
    lifecycle.markPromptSent();

    await expect(lifecycle.stopServerSessionOnce()).resolves.toEqual({ ok: true });
    expect(externalController.signal.aborted).toBe(true);
    expect(cleanupSignal).not.toBe(externalController.signal);
    expect(cleanupSignal?.aborted).toBe(false);
  });
});
