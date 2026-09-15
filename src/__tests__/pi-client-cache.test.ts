import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  interface Deferred {
    promise: Promise<void>;
    resolve: () => void;
  }

  interface SessionState {
    requestedId: string;
    instanceId: string;
    gate: Deferred;
    listener?: (event: unknown) => void;
    promptRejects: boolean;
    abortGate?: Deferred;
    shutdownRejects: boolean;
    shutdownGate?: Deferred;
    disposed: boolean;
    currentThinkingLevel: string;
    thinkingLevels: string[];
    promptThinkingLevels: string[];
    modelApplications: string[];
    promptCount: number;
  }

  function deferred(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  let sequence = 0;
  const states: SessionState[] = [];
  const events: string[] = [];
  const started = new Set<string>();

  const createAgentSession = vi.fn(async (options: {
    sessionManager: { requestedId?: string };
  }) => {
    const requestedId = options.sessionManager.requestedId ?? `anonymous-${sequence + 1}`;
    const instanceId = `${requestedId}-${++sequence}`;
    const state: SessionState = {
      requestedId,
      instanceId,
      gate: deferred(),
      promptRejects: false,
      shutdownRejects: false,
      disposed: false,
      currentThinkingLevel: 'medium',
      thinkingLevels: [],
      promptThinkingLevels: [],
      modelApplications: [],
      promptCount: 0,
    };
    states.push(state);

    const session = {
      sessionId: `sdk-${instanceId}`,
      model: { provider: 'test', id: 'model' },
      messages: [],
      setActiveToolsByName: vi.fn(),
      setModel: vi.fn(async (model: { provider: string; id: string }) => {
        state.modelApplications.push(`${model.provider}/${model.id}`);
        session.model = model;
      }),
      setThinkingLevel: vi.fn((level: string) => {
        state.currentThinkingLevel = level;
        state.thinkingLevels.push(level);
      }),
      getAllTools: vi.fn(() => [
        { name: 'read', sourceInfo: { source: 'builtin' } },
        { name: 'grep', sourceInfo: { source: 'builtin' } },
        { name: 'find', sourceInfo: { source: 'builtin' } },
        { name: 'ls', sourceInfo: { source: 'builtin' } },
        { name: 'edit', sourceInfo: { source: 'builtin' } },
        { name: 'write', sourceInfo: { source: 'builtin' } },
        { name: 'bash', sourceInfo: { source: 'sdk' } },
      ]),
      bindExtensions: vi.fn(async () => undefined),
      dispose: vi.fn(() => {
        state.disposed = true;
        events.push(`dispose:${instanceId}`);
      }),
      hasExtensionHandlers: vi.fn(() => true),
      extensionRunner: {
        emit: vi.fn(async () => {
          events.push(`shutdown:start:${instanceId}`);
          await state.shutdownGate?.promise;
          events.push(`shutdown:end:${instanceId}`);
          if (state.shutdownRejects) {
            throw new Error('shutdown failed');
          }
        }),
      },
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        state.listener = listener;
        return () => {
          state.listener = undefined;
        };
      }),
      prompt: vi.fn(async () => {
        state.promptCount += 1;
        state.promptThinkingLevels.push(state.currentThinkingLevel);
        started.add(instanceId);
        await state.gate.promise;
        if (state.promptRejects) {
          throw new Error('prompt failed');
        }
        state.listener?.({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `response:${instanceId}` }],
            stopReason: 'stop',
          },
        });
      }),
      abort: vi.fn(async () => {
        events.push(`abort:start:${instanceId}`);
        await state.abortGate?.promise;
        events.push(`abort:end:${instanceId}`);
      }),
      getLastAssistantText: vi.fn(() => `response:${instanceId}`),
    };

    return {
      session,
      extensionsResult: {
        extensions: [],
        errors: [],
        runtime: {
          pendingProviderRegistrations: [],
          pendingNativeProviderRegistrations: [],
        },
      },
    };
  });

  return {
    reset: () => {
      sequence = 0;
      states.length = 0;
      events.length = 0;
      started.clear();
    },
    createAgentSession,
    modelRuntimeCreate: vi.fn(async () => ({
      getModel: vi.fn((provider: string, id: string) => ({ provider, id })),
      getModels: vi.fn(() => [{ provider: 'test', id: 'model' }]),
      registerProvider: vi.fn(),
      registerNativeProvider: vi.fn(),
    })),
    resourceLoader: vi.fn(() => ({
      reload: vi.fn(async () => undefined),
      getExtensions: vi.fn(() => ({
        extensions: [],
        errors: [],
        runtime: {
          pendingProviderRegistrations: [],
          pendingNativeProviderRegistrations: [],
        },
      })),
    })),
    packageManagerConstructor: vi.fn(() => ({
      resolveExtensionSources: vi.fn(async () => ({ extensions: [], skills: [], prompts: [], themes: [] })),
    })),
    sessionManager: {
      inMemory: vi.fn((_cwd: string, options?: { id?: string }) => ({ requestedId: options?.id })),
    },
    settingsManagerInMemory: vi.fn(() => ({})),
    createBashToolDefinition: vi.fn(() => ({ name: 'bash' })),
    getAgentDir: vi.fn(() => path.join(tmpdir(), 'pi-cache-agent-test')),
    states,
    events,
    started,
    latestState: (requestedId: string) => [...states].reverse().find((state) => state.requestedId === requestedId),
    holdShutdown: (requestedId: string) => {
      const state = [...states].reverse().find((candidate) => candidate.requestedId === requestedId);
      if (state === undefined) {
        throw new Error(`Missing session state for ${requestedId}`);
      }
      const gate = deferred();
      state.shutdownGate = gate;
      return gate;
    },
    holdAbort: (requestedId: string) => {
      const state = [...states].reverse().find((candidate) => candidate.requestedId === requestedId);
      if (state === undefined) {
        throw new Error(`Missing session state for ${requestedId}`);
      }
      const gate = deferred();
      state.abortGate = gate;
      return gate;
    },
    releaseLatest: (requestedId: string) => {
      const state = [...states].reverse().find((candidate) => candidate.requestedId === requestedId);
      if (state === undefined) {
        throw new Error(`Missing session state for ${requestedId}`);
      }
      state.gate.resolve();
    },
  };
});

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createBashToolDefinition: mocks.createBashToolDefinition,
  createAgentSession: mocks.createAgentSession,
  DefaultPackageManager: mocks.packageManagerConstructor,
  DefaultResourceLoader: mocks.resourceLoader,
  getAgentDir: mocks.getAgentDir,
  ModelRuntime: { create: mocks.modelRuntimeCreate },
  SessionManager: mocks.sessionManager,
  SettingsManager: { inMemory: mocks.settingsManagerInMemory },
}));

vi.mock('@earendil-works/pi-ai', () => ({
  InMemoryCredentialStore: class {
    async modify(_providerId: string, action: (current: undefined) => Promise<unknown>) {
      return action(undefined);
    }
  },
  InMemoryModelsStore: class {},
}));

import { callPi } from '../infra/pi/client.js';

function options(sessionId: string) {
  return {
    cwd: path.join(tmpdir(), 'takt-pi-cache-project'),
    sessionId,
    model: 'test/model',
  };
}

describe('Pi SDK session cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  it('reuses a cached session when only the configured thinking level changes', async () => {
    const sessionId = 'thinking-level-cache';
    const first = callPi('worker', 'use low reasoning', {
      ...options(sessionId),
      providerOptions: { thinkingLevel: 'low' },
    });

    await vi.waitFor(() => expect(mocks.started.size).toBe(1));
    const firstState = mocks.latestState(sessionId)!;
    mocks.releaseLatest(sessionId);
    expect((await first).status).toBe('done');

    const second = callPi('worker', 'use high reasoning', {
      ...options(sessionId),
      providerOptions: { thinkingLevel: 'high' },
    });

    await vi.waitFor(() => expect(
      mocks.states.reduce((promptCount, state) => promptCount + state.promptCount, 0),
    ).toBe(2));
    mocks.releaseLatest(sessionId);

    expect((await second).status).toBe('done');
    expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
    expect(mocks.latestState(sessionId)).toBe(firstState);
    expect(firstState.thinkingLevels.slice(-2)).toEqual(['low', 'high']);
    expect(firstState.promptThinkingLevels).toEqual(['low', 'high']);
  });

  it('reuses a cached session when thinking level is the only configured option', async () => {
    const sessionId = 'thinking-level-only-cache';
    const first = callPi('worker', 'use the default reasoning', options(sessionId));

    await vi.waitFor(() => expect(mocks.started.size).toBe(1));
    const firstState = mocks.latestState(sessionId)!;
    mocks.releaseLatest(sessionId);
    expect((await first).status).toBe('done');

    const second = callPi('worker', 'use high reasoning', {
      ...options(sessionId),
      providerOptions: { thinkingLevel: 'high' },
    });

    await vi.waitFor(() => expect(
      mocks.states.reduce((promptCount, state) => promptCount + state.promptCount, 0),
    ).toBe(2));
    mocks.releaseLatest(sessionId);

    expect((await second).status).toBe('done');
    expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
    expect(mocks.latestState(sessionId)).toBe(firstState);
    expect(firstState.promptThinkingLevels).toEqual(['medium', 'high']);
  });

  it('restores the SDK default when an explicit thinking level becomes unset', async () => {
    const sessionId = 'thinking-level-reset-cache';
    const first = callPi('worker', 'use high reasoning', {
      ...options(sessionId),
      providerOptions: { thinkingLevel: 'high' },
    });

    await vi.waitFor(() => expect(mocks.started.size).toBe(1));
    const firstState = mocks.latestState(sessionId)!;
    mocks.releaseLatest(sessionId);
    expect((await first).status).toBe('done');

    const second = callPi('worker', 'use the SDK default', options(sessionId));

    await vi.waitFor(() => expect(
      mocks.states.reduce((promptCount, state) => promptCount + state.promptCount, 0),
    ).toBe(2));
    mocks.releaseLatest(sessionId);

    expect((await second).status).toBe('done');
    expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
    expect(mocks.latestState(sessionId)).toBe(firstState);
    expect(firstState.promptThinkingLevels).toEqual(['high', 'medium']);
  });

  it('creates a distinct cached session when a resource option changes', async () => {
    const sessionId = 'resource-option-cache';
    const first = callPi('worker', 'include skills', {
      ...options(sessionId),
      providerOptions: { noSkills: false, thinkingLevel: 'low' },
    });

    await vi.waitFor(() => expect(mocks.started.size).toBe(1));
    const firstState = mocks.latestState(sessionId)!;
    mocks.releaseLatest(sessionId);
    expect((await first).status).toBe('done');

    const second = callPi('worker', 'exclude skills', {
      ...options(sessionId),
      providerOptions: { noSkills: true, thinkingLevel: 'high' },
    });

    await vi.waitFor(() => expect(
      mocks.states.filter((state) => state.requestedId === sessionId),
    ).toHaveLength(2));
    const secondState = mocks.latestState(sessionId)!;
    mocks.releaseLatest(sessionId);

    expect((await second).status).toBe('done');
    expect(mocks.createAgentSession).toHaveBeenCalledTimes(2);
    expect(firstState).not.toBe(secondState);
    expect(firstState.promptThinkingLevels).toEqual(['low']);
    expect(secondState.promptThinkingLevels).toEqual(['high']);
  });

  it('keeps a literal colon-containing model ID when a session is reused', async () => {
    const sessionId = 'literal-colon-model-cache';
    const first = callPi('worker', 'use the literal model ID', {
      ...options(sessionId),
      model: 'test/model:high',
    });

    await vi.waitFor(() => expect(mocks.started.size).toBe(1));
    const state = mocks.latestState(sessionId)!;
    mocks.releaseLatest(sessionId);
    expect((await first).status).toBe('done');

    const second = await callPi('worker', 'reuse the literal model ID', {
      ...options(sessionId),
      model: 'test/model:high',
    });

    expect(second.status).toBe('done');
    expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
    expect(state.modelApplications).toEqual(['test/model:high']);
    expect(state.promptThinkingLevels).toEqual(['medium', 'medium']);
    expect(state.thinkingLevels).toEqual([]);
  });

  it('applies an explicit thinking option on every turn of a reused session', async () => {
    const sessionId = 'explicit-thinking-level-cache';
    const first = callPi('worker', 'use explicit low reasoning', {
      ...options(sessionId),
      providerOptions: { thinkingLevel: 'low' },
    });

    await vi.waitFor(() => expect(mocks.started.size).toBe(1));
    const state = mocks.latestState(sessionId)!;
    mocks.releaseLatest(sessionId);
    expect((await first).status).toBe('done');
    const thinkingLevelApplicationsAfterFirstTurn = state.thinkingLevels.length;

    const second = await callPi('worker', 'use a literal colon-containing model ID', {
      ...options(sessionId),
      model: 'test/model:high',
      providerOptions: { thinkingLevel: 'low' },
    });

    expect(second.status).toBe('done');
    expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
    expect(mocks.latestState(sessionId)).toBe(state);
    expect(state.thinkingLevels.slice(thinkingLevelApplicationsAfterFirstTurn)).toEqual(['low']);
    expect(state.promptThinkingLevels).toEqual(['low', 'low']);
    expect(state.modelApplications).toEqual(['test/model:high']);
  });

  it('retires an aborted session before releasing its lock', async () => {
    const controller = new AbortController();
    const first = callPi('worker', 'first', {
      ...options('abort-session'),
      abortSignal: controller.signal,
    });

    await vi.waitFor(() => expect(mocks.started.size).toBe(1));
    const firstState = mocks.latestState('abort-session')!;
    const abortGate = mocks.holdAbort('abort-session');
    controller.abort(new Error('deadline reached'));

    await vi.waitFor(() => expect(mocks.events).toContain(`abort:start:${firstState.instanceId}`));
    const second = callPi('worker', 'second', options('abort-session'));
    await vi.waitFor(() => expect(mocks.states.filter((state) => state.requestedId === 'abort-session')).toHaveLength(2));
    const secondState = mocks.latestState('abort-session')!;
    expect(secondState).not.toBe(firstState);

    let firstSettled = false;
    void first.then(() => {
      firstSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(firstSettled).toBe(false);

    abortGate.resolve();
    expect((await first).status).toBe('error');
    mocks.releaseLatest('abort-session');
    expect((await second).status).toBe('done');
    expect(mocks.events.indexOf(`abort:end:${firstState.instanceId}`)).toBeLessThan(
      mocks.events.indexOf(`dispose:${firstState.instanceId}`),
    );
  });

  it('abort cleanupがハングしても有限時間で呼び出しを解放する', async () => {
    let releaseAbort: (() => void) | undefined;
    try {
      const controller = new AbortController();
      const first = callPi('worker', 'first', {
        ...options('abort-timeout-session'),
        abortSignal: controller.signal,
      });

      await vi.waitFor(() => expect(mocks.started.size).toBe(1));
      const state = mocks.latestState('abort-timeout-session')!;
      const abortGate = mocks.holdAbort('abort-timeout-session');
      releaseAbort = abortGate.resolve;
      vi.useFakeTimers();
      controller.abort(new Error('deadline reached'));

      for (let attempt = 0; attempt < 20 && vi.getTimerCount() === 0; attempt += 1) {
        await Promise.resolve();
      }
      expect(mocks.events).toContain(`abort:start:${state.instanceId}`);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect((await first).status).toBe('error');
    } finally {
      releaseAbort?.();
      vi.useRealTimers();
    }
  });

  it('converges to the idle cache limit after 65 active sessions finish', async () => {
    const sessionIds = Array.from({ length: 65 }, (_, index) => `cache-session-${index}`);
    const calls = sessionIds.map((sessionId) => callPi('worker', 'work', options(sessionId)));

    await vi.waitFor(() => expect(mocks.started.size).toBe(65));
    expect(mocks.states.some((state) => state.disposed)).toBe(false);

    const evictedId = sessionIds[0]!;
    const evictedState = mocks.latestState(evictedId)!;
    evictedState.promptRejects = true;
    evictedState.shutdownRejects = true;
    const shutdownGate = mocks.holdShutdown(evictedId);
    mocks.releaseLatest(evictedId);

    expect((await calls[0]!).status).toBe('error');
    await vi.waitFor(() => expect(mocks.events).toContain(`shutdown:start:${evictedState.instanceId}`));
    expect(evictedState.disposed).toBe(false);

    const createCountBeforeRecreation = mocks.createAgentSession.mock.calls.length;
    const recreated = callPi('worker', 'recreate while shutdown is pending', options(evictedId));
    await vi.waitFor(() => expect(mocks.createAgentSession).toHaveBeenCalledTimes(createCountBeforeRecreation + 1));
    const recreatedState = mocks.latestState(evictedId)!;
    expect(recreatedState).not.toBe(evictedState);
    mocks.releaseLatest(evictedId);
    expect((await recreated).status).toBe('done');
    await vi.waitFor(() => expect(recreatedState.disposed).toBe(true));

    shutdownGate.resolve();
    await vi.waitFor(() => expect(evictedState.disposed).toBe(true));
    expect(mocks.events.indexOf(`shutdown:start:${evictedState.instanceId}`)).toBeLessThan(
      mocks.events.indexOf(`shutdown:end:${evictedState.instanceId}`),
    );
    expect(mocks.events.indexOf(`shutdown:end:${evictedState.instanceId}`)).toBeLessThan(
      mocks.events.indexOf(`dispose:${evictedState.instanceId}`),
    );
    expect(mocks.states.filter((state) => state.disposed)).toHaveLength(2);

    for (const sessionId of sessionIds.slice(1)) {
      mocks.releaseLatest(sessionId);
    }
    const remaining = await Promise.all(calls.slice(1));
    expect(remaining.every((response) => response.status === 'done')).toBe(true);
    expect(mocks.states.filter((state) => state.disposed)).toHaveLength(2);

    const retainedId = sessionIds[1]!;
    const createCountBeforeReuse = mocks.createAgentSession.mock.calls.length;
    expect((await callPi('worker', 'reuse', options(retainedId))).status).toBe('done');
    expect(mocks.createAgentSession).toHaveBeenCalledTimes(createCountBeforeReuse);
  });
});
