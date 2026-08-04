import { context, propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  deferred,
  successfulSessionAbort,
  makeOpenCodeClientMock,
  createTestContextManager,
  createTestTraceContextPropagator,
  createTestSpan,
} from './helpers/opencode-client-test-helpers.js';

const { createOpencodeMock } = vi.hoisted(() => ({
  createOpencodeMock: vi.fn(),
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

describe('OpenCodeClient child process env', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { resetSharedServer } = await import('../infra/opencode/client.js');
    resetSharedServer();
  });

  it('should apply childProcessEnv only while starting the shared server and restore ambient env', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const previousTaktObservability = process.env.TAKT_OBSERVABILITY;
    const previousOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ambient.example.test';
    const envSnapshots: Array<Record<string, string | undefined>> = [];
    const { sessionCreate, promptAsync, subscribe } = makeOpenCodeClientMock('env-session', ['done']);
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
        childProcessEnv: {
          TAKT_OBSERVABILITY: '{"enabled":true}',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
        },
      });

      expect(envSnapshots).toEqual([{
        TAKT_OBSERVABILITY: '{"enabled":true}',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
      }]);
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

  it('should not leak childProcessEnv into concurrent startup without childProcessEnv', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const previousTaktObservability = process.env.TAKT_OBSERVABILITY;
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    const envSnapshots: Array<Record<string, string | undefined>> = [];
    const firstStartup = deferred<Awaited<ReturnType<typeof createOpencodeMock>>>();
    const { sessionCreate: firstSessionCreate, promptAsync: firstPromptAsync, subscribe: firstSubscribe } =
      makeOpenCodeClientMock('env-leak-first-session', ['done-1']);
    const { sessionCreate: secondSessionCreate, promptAsync: secondPromptAsync, subscribe: secondSubscribe } =
      makeOpenCodeClientMock('env-leak-second-session', ['done-2']);

    createOpencodeMock
      .mockImplementationOnce(() => {
        envSnapshots.push({ TAKT_OBSERVABILITY: process.env.TAKT_OBSERVABILITY });
        return firstStartup.promise;
      })
      .mockImplementationOnce(async () => {
        envSnapshots.push({ TAKT_OBSERVABILITY: process.env.TAKT_OBSERVABILITY });
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
        childProcessEnv: { TAKT_OBSERVABILITY: '{"enabled":true}' },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      const secondCall = client.call('coder', 'task 2', {
        cwd: '/tmp',
        model: 'opencode/model-b',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(createOpencodeMock).toHaveBeenCalledTimes(1);
      expect(envSnapshots).toEqual([{ TAKT_OBSERVABILITY: '{"enabled":true}' }]);

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
      expect(envSnapshots).toEqual([
        { TAKT_OBSERVABILITY: '{"enabled":true}' },
        { TAKT_OBSERVABILITY: '{"enabled":false}' },
      ]);
    } finally {
      if (previousTaktObservability === undefined) {
        delete process.env.TAKT_OBSERVABILITY;
      } else {
        process.env.TAKT_OBSERVABILITY = previousTaktObservability;
      }
    }
  });

  it('should keep childProcessEnv until shared server startup promise settles and then restore ambient env', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const previousTaktObservability = process.env.TAKT_OBSERVABILITY;
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    const { sessionCreate, promptAsync, subscribe } = makeOpenCodeClientMock('pending-env-session', ['done']);
    let resolveStartup: (value: {
      client: {
        instance: { dispose: ReturnType<typeof vi.fn> };
        session: { create: typeof sessionCreate; promptAsync: typeof promptAsync };
        event: { subscribe: typeof subscribe };
        permission: { reply: ReturnType<typeof vi.fn> };
      };
      server: { close: ReturnType<typeof vi.fn> };
    }) => void;

    createOpencodeMock.mockImplementation(() => new Promise((resolve) => {
      resolveStartup = resolve;
    }));

    try {
      const client = new OpenCodeClient();
      const callPromise = client.call('coder', 'task', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        childProcessEnv: {
          TAKT_OBSERVABILITY: '{"enabled":true}',
        },
      });

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(createOpencodeMock).toHaveBeenCalledTimes(1);
      expect(process.env.TAKT_OBSERVABILITY).toBe('{"enabled":true}');

      resolveStartup!({
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
    } finally {
      if (previousTaktObservability === undefined) {
        delete process.env.TAKT_OBSERVABILITY;
      } else {
        process.env.TAKT_OBSERVABILITY = previousTaktObservability;
      }
    }
  });

  it('should restore env and allow later startup when OpenCode startup rejects', async () => {
    const { OpenCodeClient } = await import('../infra/opencode/client.js');
    const previousTaktObservability = process.env.TAKT_OBSERVABILITY;
    const previousOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ambient.example.test';
    const envSnapshots: Array<Record<string, string | undefined>> = [];
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
        childProcessEnv: {
          TAKT_OBSERVABILITY: '{"enabled":true,"run":1}',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector-1.example.test',
        },
      })).resolves.toMatchObject({
        status: 'error',
        content: 'startup failed',
      });
      expect(process.env.TAKT_OBSERVABILITY).toBe('{"enabled":false}');
      expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://ambient.example.test');

      await expect(client.call('coder', 'task 2', {
        cwd: '/tmp',
        model: 'opencode/big-pickle',
        childProcessEnv: {
          TAKT_OBSERVABILITY: '{"enabled":true,"run":2}',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector-2.example.test',
        },
      })).resolves.toMatchObject({ status: 'done' });

      expect(envSnapshots).toEqual([
        {
          TAKT_OBSERVABILITY: '{"enabled":true,"run":1}',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector-1.example.test',
        },
        {
          TAKT_OBSERVABILITY: '{"enabled":true,"run":2}',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector-2.example.test',
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
