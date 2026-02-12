import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  queryMock,
  interruptMock,
  AbortErrorMock,
} = vi.hoisted(() => {
  const interruptMock = vi.fn(async () => {});
  class AbortErrorMock extends Error {}
  const queryMock = vi.fn(() => {
    let interrupted = false;
    interruptMock.mockImplementation(async () => {
      interrupted = true;
    });

    return {
      interrupt: interruptMock,
      async *[Symbol.asyncIterator](): AsyncGenerator<never, void, unknown> {
        while (!interrupted) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new AbortErrorMock('aborted');
      },
    };
  });

  return {
    queryMock,
    interruptMock,
    AbortErrorMock,
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
  AbortError: AbortErrorMock,
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../shared/utils/index.js')>();
  return {
    ...original,
    createLogger: vi.fn().mockReturnValue({
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { QueryExecutor } from '../infra/claude/executor.js';

describe('QueryExecutor abortSignal wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('abortSignal 発火時に query.interrupt() を呼ぶ', async () => {
    const controller = new AbortController();
    const executor = new QueryExecutor();

    const promise = executor.execute('test', {
      cwd: '/tmp/project',
      abortSignal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    const result = await promise;

    expect(interruptMock).toHaveBeenCalledTimes(1);
    expect(result.interrupted).toBe(true);
  });

  it('開始前に中断済みの signal でも query.interrupt() を呼ぶ', async () => {
    const controller = new AbortController();
    controller.abort();

    const executor = new QueryExecutor();
    const result = await executor.execute('test', {
      cwd: '/tmp/project',
      abortSignal: controller.signal,
    });

    expect(interruptMock).toHaveBeenCalledTimes(1);
    expect(result.interrupted).toBe(true);
  });
});
