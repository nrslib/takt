import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeHeadlessCallOptions } from '../infra/claude-headless/types.js';

const { crossSpawnMock } = vi.hoisted(() => ({
  crossSpawnMock: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  crossSpawn: crossSpawnMock,
}));

const { runHeadlessCli } = await import('../infra/claude-headless/headless-spawn.js');

class MockChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn();
}

describe('Claude headless base URL env propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('baseUrl を ANTHROPIC_BASE_URL として subprocess env に注入し childProcessEnv より優先する', async () => {
    let capturedSpawnOptions: { env?: NodeJS.ProcessEnv } | undefined;
    crossSpawnMock.mockImplementation((_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      capturedSpawnOptions = options;
      const child = new MockChildProcess();
      setImmediate(() => child.emit('close', 0, null));
      return child;
    });
    const callOptions = {
      cwd: '/tmp',
      baseUrl: 'http://127.0.0.1:8787',
      childProcessEnv: {
        ANTHROPIC_BASE_URL: 'http://ambient.example.test',
      },
    } as unknown as ClaudeHeadlessCallOptions;

    await runHeadlessCli(['-p', '--', 'prompt'], callOptions);

    expect(crossSpawnMock).toHaveBeenCalledTimes(1);
    expect(capturedSpawnOptions?.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787');
  });
});
