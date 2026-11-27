vi.mock('../infra/managed-providers/loader.js', () => import('./helpers/managed-sdk.js'));
import { context, propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOpenCodeServerStartMock } from './helpers/opencode-server-process-test-helpers.js';
import {
  deferred,
  successfulSessionAbort,
  makeOpenCodeClientMock,
  createTestContextManager,
  createTestTraceContextPropagator,
  createTestSpan,
} from './helpers/opencode-client-test-helpers.js';

const { createOpencodeMock, startOpenCodeServerMock } = vi.hoisted(() => ({
  createOpencodeMock: vi.fn(),
  startOpenCodeServerMock: vi.fn(),
}));

vi.mock('node:net', () => ({
  createServer: () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    return {
      unref: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      }),
      listen: vi.fn((_port: number, _host: string, cb: () => void) => {
        cb();
      }),
      address: vi.fn(() => ({ port: 62000 })),
      close: vi.fn((cb?: (err?: Error) => void) => cb?.()),
    };
  },
}));

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencode: createOpencodeMock,
}));

vi.mock('../infra/opencode/server-process.js', () => ({
  startOpenCodeServer: startOpenCodeServerMock,
}));

describe('OpenCodeClient child process env', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    startOpenCodeServerMock.mockImplementation(createOpenCodeServerStartMock(createOpencodeMock));
    const { resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();
  });

  it('should pass childProcessEnv to server startup without changing the parent environment', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const previousTaktObservability = process.env.TAKT_OBSERVABILITY;
    const previousOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ambient.example.test';
    const childProcessEnv = {
      TAKT_OBSERVABILITY: '{"enabled":true}',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
    };
    const startup = deferred<Awaited<ReturnType<typeof createOpencodeMock>>>();
    const { sessionCreate, promptAsync, subscribe } = makeOpenCodeClientMock('env-session', ['done']);
    createOpencodeMock.mockReturnValue(startup.promise);

    try {
      const client = new OpenCodeClient();
      const callPromise = client.call('coder', 'task', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        childProcessEnv,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(startOpenCodeServerMock).toHaveBeenCalledWith(expect.objectContaining({ childProcessEnv }));
      expect(process.env.TAKT_OBSERVABILITY).toBe('{"enabled":false}');
      expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://ambient.example.test');
      expect(createOpencodeMock).toHaveBeenCalledTimes(1);

      startup.resolve({
        client: {
          instance: { dispose: vi.fn() },
          session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
          event: { subscribe },
          permission: { reply: vi.fn() },
        },
        server: { close: vi.fn() },
      });
      await expect(callPromise).resolves.toMatchObject({ status: 'done' });
      expect(process.env.TAKT_OBSERVABILITY).toBe('{"enabled":false}');
      expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://ambient.example.test');
    } finally {
      if (previousTaktObservability === undefined) {
        delete process.env.TAKT_OBSERVABILITY;
      } else {
        process.env.TAKT_OBSERVABILITY = previousTaktObservability;
      }
      if (previousOtlpEndpoint === undefined) {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      } else {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousOtlpEndpoint;
      }
    }
  });

  it('should preserve ambient observability env while starting without childProcessEnv', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const previousTaktObservability = process.env.TAKT_OBSERVABILITY;
    const previousOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ambient.example.test';
    const envSnapshots: Array<Record<string, string | undefined>> = [];
    const { sessionCreate, promptAsync, subscribe } = makeOpenCodeClientMock('ambient-env-session', ['done']);
    createOpencodeMock.mockImplementation(async () => {
      envSnapshots.push({
        TAKT_OBSERVABILITY: process.env.TAKT_OBSERVABILITY,
        OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      });
      return {
        client: {
          instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
          event: { subscribe },
          permission: { reply: vi.fn() },
        },
        server: { close: vi.fn() },
      };
    });

    try {
      const client = new OpenCodeClient();
      await client.call('coder', 'task', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
      });

      expect(envSnapshots).toEqual([{
        TAKT_OBSERVABILITY: '{"enabled":false}',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://ambient.example.test',
      }]);
      expect(startOpenCodeServerMock.mock.calls[0]?.[0]).not.toHaveProperty('childProcessEnv');
      expect(process.env.TAKT_OBSERVABILITY).toBe('{"enabled":false}');
      expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://ambient.example.test');
    } finally {
      if (previousTaktObservability === undefined) {
        delete process.env.TAKT_OBSERVABILITY;
      } else {
        process.env.TAKT_OBSERVABILITY = previousTaktObservability;
      }
      if (previousOtlpEndpoint === undefined) {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      } else {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousOtlpEndpoint;
      }
    }
  });

  it('should pass separate snapshots to concurrent server startups without changing the parent environment', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const previousTaktObservability = process.env.TAKT_OBSERVABILITY;
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    const previousOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ambient.example.test';
    const firstChildProcessEnv = {
      TAKT_OBSERVABILITY: '{"enabled":true,"run":1}',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector-1.example.test',
    };
    const secondChildProcessEnv = {
      TAKT_OBSERVABILITY: '{"enabled":true,"run":2}',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector-2.example.test',
    };
    const firstStartup = deferred<Awaited<ReturnType<typeof createOpencodeMock>>>();
    const { sessionCreate: firstSessionCreate, promptAsync: firstPromptAsync, subscribe: firstSubscribe } =
      makeOpenCodeClientMock('env-leak-first-session', ['done-1']);
    const { sessionCreate: secondSessionCreate, promptAsync: secondPromptAsync, subscribe: secondSubscribe } =
      makeOpenCodeClientMock('env-leak-second-session', ['done-2']);

    createOpencodeMock
      .mockImplementationOnce(() => firstStartup.promise)
      .mockImplementationOnce(async () => {
        return {
          client: {
            instance: { dispose: vi.fn() },
            session: { create: secondSessionCreate, promptAsync: secondPromptAsync, abort: successfulSessionAbort() },
            event: { subscribe: secondSubscribe },
            permission: { reply: vi.fn() },
          },
          server: { close: vi.fn() },
        };
      });

    try {
      const client = new OpenCodeClient();
      const firstCall = client.call('coder', 'task 1', {
        cwd: '/tmp',
        model: 'opencode/model-a',
        childProcessEnv: firstChildProcessEnv,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      const secondCall = client.call('coder', 'task 2', {
        cwd: '/tmp',
        model: 'opencode/model-b',
        childProcessEnv: secondChildProcessEnv,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(startOpenCodeServerMock).toHaveBeenCalledTimes(2);
      expect(startOpenCodeServerMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ childProcessEnv: firstChildProcessEnv }),
      );
      expect(startOpenCodeServerMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ childProcessEnv: secondChildProcessEnv }),
      );
      expect(process.env.TAKT_OBSERVABILITY).toBe('{"enabled":false}');
      expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://ambient.example.test');

      firstStartup.resolve({
        client: {
          instance: { dispose: vi.fn() },
          session: { create: firstSessionCreate, promptAsync: firstPromptAsync, abort: successfulSessionAbort() },
          event: { subscribe: firstSubscribe },
          permission: { reply: vi.fn() },
        },
        server: { close: vi.fn() },
      });

      await expect(firstCall).resolves.toMatchObject({ status: 'done' });
      await expect(secondCall).resolves.toMatchObject({ status: 'done' });
      expect(process.env.TAKT_OBSERVABILITY).toBe('{"enabled":false}');
      expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://ambient.example.test');
    } finally {
      if (previousTaktObservability === undefined) {
        delete process.env.TAKT_OBSERVABILITY;
      } else {
        process.env.TAKT_OBSERVABILITY = previousTaktObservability;
      }
      if (previousOtlpEndpoint === undefined) {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      } else {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousOtlpEndpoint;
      }
    }
  });

  it('should keep the parent environment unchanged after startup failure and pass the next snapshot', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const previousTaktObservability = process.env.TAKT_OBSERVABILITY;
    const previousOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ambient.example.test';
    const envSnapshots: Array<Record<string, string | undefined>> = [];
    const firstChildProcessEnv = {
      TAKT_OBSERVABILITY: '{"enabled":true,"run":1}',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector-1.example.test',
    };
    const secondChildProcessEnv = {
      TAKT_OBSERVABILITY: '{"enabled":true,"run":2}',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector-2.example.test',
    };
    const { sessionCreate, promptAsync, subscribe } = makeOpenCodeClientMock('after-reject-session', ['done']);
    createOpencodeMock
      .mockImplementationOnce(async () => {
        envSnapshots.push({
          TAKT_OBSERVABILITY: process.env.TAKT_OBSERVABILITY,
          OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
        });
        throw new Error('startup failed');
      })
      .mockImplementationOnce(async () => {
        envSnapshots.push({
          TAKT_OBSERVABILITY: process.env.TAKT_OBSERVABILITY,
          OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
        });
        return {
          client: {
            instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
            event: { subscribe },
            permission: { reply: vi.fn() },
          },
          server: { close: vi.fn() },
        };
      });

    try {
      const client = new OpenCodeClient();
      await expect(client.call('coder', 'task 1', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        childProcessEnv: firstChildProcessEnv,
      })).resolves.toMatchObject({
        status: 'error',
        content: 'startup failed',
      });
      expect(startOpenCodeServerMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ childProcessEnv: firstChildProcessEnv }),
      );
      expect(envSnapshots).toEqual([{
        TAKT_OBSERVABILITY: '{"enabled":false}',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://ambient.example.test',
      }]);
      expect(process.env.TAKT_OBSERVABILITY).toBe('{"enabled":false}');
      expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://ambient.example.test');

      await expect(client.call('coder', 'task 2', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        childProcessEnv: secondChildProcessEnv,
      })).resolves.toMatchObject({ status: 'done' });

      expect(startOpenCodeServerMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ childProcessEnv: secondChildProcessEnv }),
      );
      expect(envSnapshots).toEqual([
        {
          TAKT_OBSERVABILITY: '{"enabled":false}',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://ambient.example.test',
        },
        {
          TAKT_OBSERVABILITY: '{"enabled":false}',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://ambient.example.test',
        },
      ]);
      expect(process.env.TAKT_OBSERVABILITY).toBe('{"enabled":false}');
      expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://ambient.example.test');
    } finally {
      if (previousTaktObservability === undefined) {
        delete process.env.TAKT_OBSERVABILITY;
      } else {
        process.env.TAKT_OBSERVABILITY = previousTaktObservability;
      }
      if (previousOtlpEndpoint === undefined) {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      } else {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousOtlpEndpoint;
      }
    }
  });

  it('should create a separate shared server when childProcessEnv snapshot changes', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const serverCloseFns: Array<ReturnType<typeof vi.fn>> = [];
    createOpencodeMock.mockImplementation(async () => {
      const index = createOpencodeMock.mock.calls.length;
      const { sessionCreate, promptAsync, subscribe } = makeOpenCodeClientMock(`env-session-${index}`, [`done-${index}`]);
      const close = vi.fn();
      serverCloseFns.push(close);
      return {
        client: {
          instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
          event: { subscribe },
          permission: { reply: vi.fn() },
        },
        server: { close },
      };
    });

    const client = new OpenCodeClient();
    await client.call('coder', 'task 1', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      childProcessEnv: { TAKT_OBSERVABILITY: '{"enabled":true,"run":1}' },
    });
    await client.call('coder', 'task 2', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      childProcessEnv: { TAKT_OBSERVABILITY: '{"enabled":true,"run":2}' },
    });

    expect(createOpencodeMock).toHaveBeenCalledTimes(2);
    expect(serverCloseFns[0]).not.toHaveBeenCalled();
    expect(serverCloseFns[1]).not.toHaveBeenCalled();
  });

  it('should reuse the shared server when only active trace context changes', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    context.disable();
    propagation.disable();
    context.setGlobalContextManager(createTestContextManager());
    propagation.setGlobalPropagator(createTestTraceContextPropagator());
    const serverCloseFns: Array<ReturnType<typeof vi.fn>> = [];
    createOpencodeMock.mockImplementation(async () => {
      const index = createOpencodeMock.mock.calls.length;
      const { sessionCreate, promptAsync, subscribe } = makeOpenCodeClientMock(`trace-session-${index}`, [`done-${index}`]);
      const close = vi.fn();
      serverCloseFns.push(close);
      return {
        client: {
          instance: { dispose: vi.fn() },
        session: { create: sessionCreate, promptAsync, abort: successfulSessionAbort() },
          event: { subscribe },
          permission: { reply: vi.fn() },
        },
        server: { close },
      };
    });

    try {
      const client = new OpenCodeClient();
      await context.with(
        trace.setSpan(ROOT_CONTEXT, createTestSpan('11111111111111111111111111111111', '1111111111111111')),
        () => client.call('coder', 'task 1', {
          cwd: '/tmp',
          model: 'opencode/big-pickle',
          childProcessEnv: { TAKT_OBSERVABILITY: '{"enabled":true}' },
        }),
      );
      await context.with(
        trace.setSpan(ROOT_CONTEXT, createTestSpan('22222222222222222222222222222222', '2222222222222222')),
        () => client.call('coder', 'task 2', {
          cwd: '/tmp',
          model: 'opencode/big-pickle',
          childProcessEnv: { TAKT_OBSERVABILITY: '{"enabled":true}' },
        }),
      );

      expect(createOpencodeMock).toHaveBeenCalledTimes(1);
      expect(serverCloseFns[0]).not.toHaveBeenCalled();
    } finally {
      context.disable();
      propagation.disable();
    }
  });
});
