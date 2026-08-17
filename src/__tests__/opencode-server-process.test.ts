import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

const { crossSpawnMock, createClientMock } = vi.hoisted(() => ({
  crossSpawnMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.unmock('../infra/opencode/server-process.js');

vi.mock('../shared/utils/spawn.js', () => ({
  crossSpawn: crossSpawnMock,
}));

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: createClientMock,
}));

describe('OpenCode server process', () => {
  it('should convert child stdio EPIPE into a server error without an unhandled event', async () => {
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    const client = {};
    crossSpawnMock.mockReturnValue(child);
    createClientMock.mockReturnValue(client);

    const { startOpenCodeServer } = await import('../infra/opencode/server-process.js');
    const startPromise = startOpenCodeServer({
      port: 62000,
      timeoutMs: 100,
      config: { model: 'opencode/model' },
    });
    stdout.emit('data', 'opencode server listening on http://127.0.0.1:62000\n');
    const server = await startPromise;
    const errors: Error[] = [];

    server.onError((error) => errors.push(error));
    stderr.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

    expect(stdout.listenerCount('error')).toBe(1);
    expect(stderr.listenerCount('error')).toBe(1);
    expect(stdin.listenerCount('error')).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('OpenCode server stderr stream failed: write EPIPE');
    expect(createClientMock).toHaveBeenCalledWith({ baseUrl: 'http://127.0.0.1:62000' });

    server.close();
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
