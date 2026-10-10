import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '../shared/types/provider.js';
import { OpenCodeProvider } from '../infra/providers/opencode.js';
import { OpenCodeClient } from '../infra/opencode/client.js';
import * as serverPool from '../infra/opencode/server-pool.js';
import { deferred } from './helpers/opencode-client-test-helpers.js';

const { loadSdk, startServer, runtime } = vi.hoisted(() => ({
  loadSdk: vi.fn(), startServer: vi.fn(), runtime: { generation: 'v1' as 'v1' | 'v2' },
}));
vi.mock('../infra/managed-providers/loader.js', () => ({ loadManagedSdk: loadSdk }));
vi.mock('../infra/opencode/runtime.js', () => ({
  openCodeRuntimeSelection: () => ({ generation: runtime.generation, command: 'opencode' }),
  resolveOpenCodeRuntime: async () => ({ generation: runtime.generation, command: 'opencode', version: runtime.generation === 'v1' ? '1.18.2' : '2.0.18' }),
}));
vi.mock('node:net', () => ({ createServer: () => ({
  unref: vi.fn(), on: vi.fn(), listen: (_port: number, _host: string, ready: () => void) => ready(),
  address: () => ({ port: 62000 }), close: (done: () => void) => done(),
}) }));
vi.mock('../infra/opencode/server-process.js', () => ({ startOpenCodeServer: startServer }));

let failure: Error;
const options = { cwd: '/work', model: 'opencode/big-pickle', sessionId: 'session-1' };
type FailureOperation = 'call' | 'custom' | 'model' | 'summarize' | 'summary';

function createSdk(generation: 'A' | 'B') {
  const state = {
    fail: undefined as FailureOperation | undefined,
    hold: undefined as ReturnType<typeof deferred<void>> | undefined,
    entered: deferred<void>(),
    summaries: 0,
    operations: [] as string[],
  };
  const runPrompt = async (_input: unknown) => {
    state.operations.push(`${generation}:prompt`);
    state.entered.resolve();
    await state.hold?.promise;
    if (state.fail === 'call' || state.fail === 'custom') throw failure;
  };
  const summarize = async () => {
    state.operations.push(`${generation}:summarize`);
    if (state.fail === 'summarize') throw failure;
    state.summaries += 1;
  };
  const messages = () => {
    state.operations.push(`${generation}:messages`);
    if (state.fail === 'summary' && state.summaries > 0) throw failure;
    return state.summaries === 0 ? [] : [{
      info: { id: `summary-${state.summaries}`, role: 'assistant', summary: true, time: { created: 1, completed: 1 } }, parts: [],
    }];
  };
  const model = () => {
    state.operations.push(`${generation}:model`);
    if (state.fail === 'model') throw failure;
    return { providerID: 'opencode', modelID: 'big-pickle' };
  };
  const v1 = {
    app: { agents: vi.fn(async () => ({ data: [{ name: 'takt', model: model() }] })) },
    session: {
      create: vi.fn(async () => ({ data: { id: 'session-1' } })),
      get: vi.fn(async () => ({ data: { id: 'session-1' } })),
      messages: vi.fn(async () => ({ data: messages() })),
      promptAsync: vi.fn(runPrompt), abort: vi.fn(async () => ({ data: true })),
      summarize: vi.fn(summarize),
    },
    event: { subscribe: vi.fn(async () => ({ stream: (async function* () {
      yield { type: 'message.part.updated', properties: { part: { id: 'text-1', sessionID: 'session-1', type: 'text', text: 'success' } } };
      yield { type: 'session.idle', properties: { sessionID: 'session-1' } };
    })() })) },
    permission: { reply: vi.fn() }, question: { reply: vi.fn(), reject: vi.fn() },
  };
  const v2 = {
    agent: { list: vi.fn(async () => ({ data: [{ id: 'takt', name: 'takt', model: { providerID: model().providerID, id: 'big-pickle' } }] })) },
    session: {
      create: vi.fn(async () => ({ id: 'session-1' })),
      get: vi.fn(async () => ({ id: 'session-1', location: { directory: '/work' }, metadata: {} })),
      update: vi.fn(async (_input: unknown) => undefined), switchAgent: vi.fn(async () => undefined), switchModel: vi.fn(async () => undefined),
      prompt: vi.fn(runPrompt), interrupt: vi.fn(async () => undefined), wait: vi.fn(async () => undefined), compact: vi.fn(summarize),
    },
    plugin: { list: vi.fn(async () => ({ data: [{ id: 'takt.session', state: { status: 'active' } }] })) },
    rpc: { call: vi.fn(async () => ({ output: [] })) },
    mcp: { list: vi.fn(async () => ({ data: [] })) },
    message: { list: vi.fn(async () => ({ data: messages().map((message) => ({ id: message.info.id, type: 'compaction', status: 'completed', time: { created: 1 } })), cursor: { next: null } })) },
    event: { subscribe: vi.fn(() => (async function* () {
      yield { type: 'server.connected' };
      yield { type: 'session.text.ended', data: { sessionID: 'session-1', assistantMessageID: 'message-1', ordinal: 0, text: 'success' } };
      yield { type: 'session.execution.succeeded', data: { sessionID: 'session-1' } };
    })()) },
    permission: { reply: vi.fn() },
  };
  return { state, v1, v2, loaded: {
    directory: `/test/managed/opencode/sdk-${generation}`, stale: generation === 'A',
    modules: [{ createOpencodeClient: () => v1 }, { OpenCode: { make: () => v2 } }],
  } };
}

let sdkA: ReturnType<typeof createSdk>;
let sdkB: ReturnType<typeof createSdk>;
let serverError: (error: Error) => void;

beforeEach(() => {
  serverPool.resetSharedServerPool();
  vi.clearAllMocks();
  sdkA = createSdk('A'); sdkB = createSdk('B');
  loadSdk.mockResolvedValue(sdkA.loaded);
  startServer.mockImplementation(async () => {
    const { createV1Transport } = await import('../infra/opencode/v1-transport.js');
    const { createV2Transport } = await import('../infra/opencode/v2-transport.js');
    const client = runtime.generation === 'v1'
      ? await createV1Transport('http://localhost') : await createV2Transport('http://localhost', 'fixture');
    return { client, close: vi.fn(async () => undefined), onError: (listener: (error: Error) => void) => {
      serverError = listener;
      return () => undefined;
    } };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  serverPool.resetSharedServerPool();
});

function expectAdvice(message: string, stale: boolean) {
  expect(message).toContain(failure.message);
  const alreadyAdvised = failure.message.includes('takt update opencode');
  expect.soft(message.match(/takt update opencode/g) ?? []).toHaveLength(stale || alreadyAdvised ? 1 : 0);
}

describe.each([
  ['v1', 'codex'], ['v1', 'opencode'], ['v2', 'codex'], ['v2', 'opencode'],
] as const)('OpenCode %s managed SDK generation with existing %s update advice', (version, advisedProvider) => {
  beforeEach(() => {
    failure = new Error(`controlled SDK failure. Run \`takt update ${advisedProvider}\`.`);
  });
  it.each([false, true])('preserves successful session reuse after update, custom=%s', async (custom) => {
    runtime.generation = version;
    const agent = new OpenCodeProvider().setup({ name: 'coder', ...(custom ? { systemPrompt: 'You are a helpful assistant.' } : {}) });
    const events: StreamEvent[] = [];
    await agent.call('initial', options);
    loadSdk.mockResolvedValue(sdkB.loaded);
    const response = await agent.call('continued', { ...options, onStream: (event) => events.push(event) });
    expect(response).toMatchObject({ status: 'done', content: 'success', sessionId: 'session-1' });
    expect(events.filter((event) => event.type === 'result')).toEqual([
      expect.objectContaining({ type: 'result', data: expect.objectContaining({ result: 'success', success: true, sessionId: 'session-1' }) }),
    ]);
    expect(startServer).toHaveBeenCalledOnce();
    expect(sdkB.state.operations).toEqual([]);
    const prompts = version === 'v1' ? sdkA.v1.session.promptAsync : sdkA.v2.session.update;
    expect(prompts).toHaveBeenCalledTimes(2);
    if (custom) {
      expect(prompts.mock.calls[1]![0]).toEqual(expect.objectContaining(version === 'v1'
        ? { system: expect.stringContaining('You are a helpful assistant.') }
        : { metadata: expect.objectContaining({ takt: expect.objectContaining({ system: expect.stringContaining('You are a helpful assistant.') }) }) }));
    }
  });

  it.each(['call', 'custom', 'summarize'] as const)('checks current installation before reusing a transport: %s', async (operation) => {
    runtime.generation = version;
    const client = new OpenCodeClient();
    await client.call('coder', 'initial', options);
    const previousOperations = [...sdkA.state.operations];
    loadSdk.mockRejectedValue(new Error('Managed SDK integrity check failed. Run `takt install opencode`.'));
    if (operation === 'summarize') await expect(client.compactSession(options)).rejects.toThrow('takt install opencode');
    else {
      const response = operation === 'custom'
        ? await client.callCustom('coder', 'failure', 'You are a helpful assistant.', options)
        : await client.call('coder', 'failure', options);
      expect(response.status).toBe('error');
      expect(response.error).toContain('takt install opencode');
    }
    expect(sdkA.state.operations).toEqual(previousOperations);
    expect(startServer).toHaveBeenCalledOnce();
  });

  for (const stale of [true, false]) {
    it.each(['call', 'custom', 'summarize'] as const)(`uses the selected SDK when a queued session is rejected: %s, stale=${stale}`, async (operation) => {
      runtime.generation = version;
      if (!stale) loadSdk.mockResolvedValue(sdkB.loaded);
      const client = new OpenCodeClient();
      await client.call('coder', 'initial', options);
      const held = await serverPool.acquireOpenCodeClient(options.model, undefined, undefined, undefined, options.sessionId);
      loadSdk.mockResolvedValue(sdkB.loaded);
      const queued = deferred<void>();
      const acquire = serverPool.acquireOpenCodeClient;
      vi.spyOn(serverPool, 'acquireOpenCodeClient').mockImplementation((...args) => {
        const pending = acquire(...args);
        queued.resolve();
        return pending;
      });
      const events: StreamEvent[] = [];
      const callOptions = { ...options, onStream: (event: StreamEvent) => events.push(event) };
      const pending = operation === 'summarize'
        ? client.compactSession(options).catch((error: unknown) => error)
        : operation === 'custom'
          ? client.callCustom('coder', 'queued', 'You are a helpful assistant.', callOptions)
          : client.call('coder', 'queued', callOptions);
      await queued.promise;
      serverError(failure);
      const result = await pending;
      if (operation === 'summarize') {
        expect(result).toBeInstanceOf(Error);
        expectAdvice((result as Error).message, stale);
      } else {
        expect(result).toMatchObject({ status: 'error', sessionId: 'session-1' });
        const response = result as Awaited<ReturnType<OpenCodeClient['call']>>;
        expectAdvice(response.content, stale);
        expectAdvice(response.error!, stale);
        const terminal = events.filter((event) => event.type === 'result');
        expect(terminal).toHaveLength(1);
        for (const event of terminal) {
          if (event.type !== 'result') throw new Error('Expected result');
          expect(event.data.success).toBe(false);
          expectAdvice(event.data.result, stale);
          if (event.data.error !== undefined) expectAdvice(event.data.error, stale);
        }
      }
      held.release();
      expect(startServer).toHaveBeenCalledOnce();
    });
  }

  it.each(['A', 'B'] as const)('isolates SDK state in parallel calls when %s completes first', async (first) => {
    runtime.generation = version;
    const client = new OpenCodeClient();
    await client.call('coder', 'initial', options);
    loadSdk.mockResolvedValue(sdkB.loaded);
    sdkA.state.fail = 'call'; sdkB.state.fail = 'call';
    sdkA.state.entered = deferred<void>(); sdkA.state.hold = deferred<void>();
    sdkB.state.entered = deferred<void>(); sdkB.state.hold = deferred<void>();
    const eventsA: StreamEvent[] = []; const eventsB: StreamEvent[] = [];
    const pendingA = client.call('coder', 'A', { ...options, onStream: (event) => eventsA.push(event) });
    await sdkA.state.entered.promise;
    const pendingB = client.call('coder', 'B', { ...options, model: 'opencode/other-pickle', onStream: (event) => eventsB.push(event) });
    await sdkB.state.entered.promise;
    if (first === 'A') { sdkA.state.hold.resolve(); await pendingA; sdkB.state.hold.resolve(); }
    else { sdkB.state.hold.resolve(); await pendingB; sdkA.state.hold.resolve(); }
    const [responseA, responseB] = await Promise.all([pendingA, pendingB]);
    expect(responseA.status).toBe('error'); expect(responseB.status).toBe('error');
    expectAdvice(responseA.content, true); expectAdvice(responseB.content, false);
    expectAdvice(responseA.error!, true); expectAdvice(responseB.error!, false);
    for (const [events, stale] of [[eventsA, true], [eventsB, false]] as const) {
      const terminal = events.filter((event) => event.type === 'result');
      expect(terminal).toHaveLength(1);
      for (const event of terminal) {
        if (event.type !== 'result') throw new Error('Expected result');
        expect(event.data.success).toBe(false);
        expectAdvice(event.data.result, stale);
        if (event.data.error !== undefined) expectAdvice(event.data.error, stale);
      }
    }
    expect(startServer).toHaveBeenCalledTimes(2);
  });

  for (const repetition of [1, 2]) {
    for (const publishAfterCreation of [true, false]) {
      it.each(['call', 'custom', 'model', 'summarize', 'summary'] as const)(
        `keeps failure advice tied to the used SDK: %s, update after creation=${publishAfterCreation}, repetition=${repetition}`,
        async (operation) => {
          runtime.generation = version;
          if (!publishAfterCreation) loadSdk.mockResolvedValue(sdkB.loaded);
          const used = publishAfterCreation ? sdkA : sdkB;
          const agent = new OpenCodeProvider().setup({ name: 'coder', ...(operation === 'custom' ? { systemPrompt: 'You are a helpful assistant.' } : {}) });
          const callOptions = operation === 'model' ? { ...options, model: undefined, allowDefaultModel: true } : options;
          const initial = await agent.call('initial', callOptions);
          expect(initial).toMatchObject({ status: 'done', content: 'success', sessionId: 'session-1' });
          loadSdk.mockResolvedValue(sdkB.loaded);
          used.state.fail = operation;
          const events: StreamEvent[] = [];
          if (operation === 'summarize' || operation === 'summary') {
            const error = await new OpenCodeClient().compactSession(options).catch((error: unknown) => error);
            expect(error).toBeInstanceOf(Error);
            expectAdvice((error as Error).message, publishAfterCreation);
            if (publishAfterCreation) expect.soft((error as Error).cause).toBe(failure);
            else expect(error).toBe(failure);
          } else {
            const result = await agent.call('failure', { ...callOptions, onStream: (event) => events.push(event) });
            expect(result).toMatchObject({ status: 'error', sessionId: 'session-1' });
            expectAdvice(result.content, publishAfterCreation);
            expectAdvice(result.error!, publishAfterCreation);
            const terminal = events.filter((event) => event.type === 'result');
            if (operation === 'model') expect(terminal).toHaveLength(0);
            else {
              expect(terminal).toHaveLength(1);
              for (const event of terminal) {
                if (event.type !== 'result') throw new Error('Expected result');
                expect(event.data.success).toBe(false);
                expectAdvice(event.data.result, publishAfterCreation);
                if (event.data.error !== undefined) expectAdvice(event.data.error, publishAfterCreation);
              }
            }
          }
          expect(startServer).toHaveBeenCalledTimes(operation === 'model' ? 2 : 1);
          expect(used.state.operations.length).toBeGreaterThan(1);
          expect((publishAfterCreation ? sdkB : sdkA).state.operations).toEqual([]);
        },
      );
    }
  }
});
