import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../infra/deepseek-harness/managed-package.js', async (importOriginal) => {
  const managed = await importOriginal<typeof import('../infra/deepseek-harness/managed-package.js')>();
  const [sdk, llm] = await Promise.all([
    import('@deepseek-ai/dsh-sdk-client'),
    import('@deepseek-ai/dsh-llm'),
  ]);
  return {
    ...managed,
    loadManagedDeepSeekHarnessModules: async () => ({
      directory: process.cwd(),
      sdk,
      llm,
    }),
  };
});

const runtimeBehavior = vi.hoisted(() => ({
  runError: undefined as unknown,
  closeError: undefined as unknown,
  notifications: [] as unknown[],
  startCount: 0,
  runCount: 0,
  closeCount: 0,
  instanceCount: 0,
  uniqueSessions: false,
  confirmedExit: false,
  runGate: undefined as ((prompt: string) => Promise<void>) | undefined,
  onClose: undefined as (() => Promise<void>) | undefined,
}));
const runtimeStateBehavior = vi.hoisted(() => ({
  blockCreationAtStart: false,
  failBarrierPublication: false,
  failPatchDisposal: false,
}));

vi.mock('@deepseek-ai/dsh-sdk-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-sdk-client')>();
  return {
    ...actual,
    DeepSeekHarness: class {
      private readonly id = runtimeBehavior.uniqueSessions ? `cache-session-${++runtimeBehavior.instanceCount}` : 'error-mapping-session';
      /** Capture the mocked SDK environment so cleanup tests can publish the configured exit receipt. */
      constructor(private readonly options: { env?: NodeJS.ProcessEnv }) {}

      /** Count SDK startup calls without creating a runtime process. */
      async start(): Promise<void> {
        runtimeBehavior.startCount += 1;
      }

      /** Simulate SDK events or a controlled rejection, allowing tests to gate execution and inspect failure mapping. */
      async run(
        _prompt: string,
        options?: { onNotification?: (notification: unknown) => void },
      ): Promise<{ sessionId: string; finalResponse: string; finishReason: 'completed' }> {
        runtimeBehavior.runCount += 1;
        await runtimeBehavior.runGate?.(_prompt);
        if (runtimeBehavior.runError !== undefined) {
          throw runtimeBehavior.runError;
        }
        for (const notification of runtimeBehavior.notifications) {
          options?.onNotification?.(notification);
        }
        if (runtimeBehavior.uniqueSessions) {
          options?.onNotification?.({ method: 'session.event', params: { sessionId: this.id, event: {
            type: 'turn/end', data: { reason: { kind: 'completed' } },
          } } });
        }
        return { sessionId: this.id, finalResponse: 'ok', finishReason: 'completed' };
      }

      /** Simulate cleanup, optionally write a proven-exit receipt, then inject the configured close failure. */
      async close(): Promise<void> {
        runtimeBehavior.closeCount += 1;
        await runtimeBehavior.onClose?.();
        if (runtimeBehavior.confirmedExit && this.options.env?.TAKT_DSH_CLEANUP_CONFIRMATION) {
          await writeFile(this.options.env.TAKT_DSH_CLEANUP_CONFIRMATION, 'confirmed\n');
        }
        if (runtimeBehavior.closeError !== undefined) {
          throw runtimeBehavior.closeError;
        }
      }
    },
  };
});

vi.mock('../infra/deepseek-harness/credential-patch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/deepseek-harness/credential-patch.js')>();
  return {
    ...actual,
    createDeepSeekCredentialPatch: async (...args: Parameters<typeof actual.createDeepSeekCredentialPatch>) => {
      const patch = await actual.createDeepSeekCredentialPatch(...args);
      return {
        ...patch,
        dispose: async (): Promise<void> => {
          await patch.dispose();
          if (runtimeStateBehavior.failPatchDisposal) throw new Error('patch disposal failed');
        },
      };
    },
  };
});

vi.mock('../infra/deepseek-harness/runtime-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/deepseek-harness/runtime-state.js')>();
  return {
    ...actual,
    markDeepSeekCleanupFailure: (): Promise<void> => runtimeStateBehavior.failBarrierPublication
      ? Promise.reject(new Error('barrier publication failed'))
      : actual.markDeepSeekCleanupFailure(),
    withDeepSeekRuntimeCreation: <T,>(
      create: () => Promise<T>,
      cleanupAfterFailure?: () => Promise<boolean>,
    ): Promise<T> => {
      if (runtimeStateBehavior.blockCreationAtStart) {
        return Promise.reject(new actual.DeepSeekRuntimeCreationBlockedError());
      }
      return actual.withDeepSeekRuntimeCreation(create, cleanupAfterFailure);
    },
  };
});

import {
  JsonRpcResponseError,
  RequestTimeoutError,
  SdkProtocolError,
  TransportClosedError,
} from '@deepseek-ai/dsh-sdk-client';
import { callDeepSeekHarness, closeDeepSeekHarnessProcesses } from '../infra/deepseek-harness/index.js';
import {
  DeepSeekRuntimeCreationBlockedError,
  deepSeekCleanupBlockedMessage,
  getDeepSeekRuntimePaths,
  withDeepSeekRuntimeCreation,
} from '../infra/deepseek-harness/runtime-state.js';
import { AGENT_FAILURE_CATEGORIES } from '../shared/types/agent-failure.js';
import type { StreamEvent } from '../shared/types/provider.js';

const environmentKeys = ['TAKT_CONFIG_DIR', 'DSH_HOME', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'TMPDIR'] as const;
const savedEnvironment = new Map<string, string | undefined>();
const RAW_FAILURE_SENTINEL = 'TAKT_RAW_SDK_FAILURE_SENTINEL';
let temporaryRoot: string;

describe('DeepSeek Harness SDK error mapping', () => {
  beforeEach(async () => {
    for (const key of environmentKeys) savedEnvironment.set(key, process.env[key]);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'takt-deepseek-error-mapping-'));
    process.env.TMPDIR = path.join(temporaryRoot, 'tmp');
    await mkdir(process.env.TMPDIR, { recursive: true });
    process.env.TAKT_CONFIG_DIR = path.join(temporaryRoot, 'takt-config');
    process.env.DSH_HOME = path.join(temporaryRoot, 'credential-source');
    process.env.DEEPSEEK_API_KEY = 'TAKT_DUMMY_ERROR_MAPPING_CREDENTIAL';
    delete process.env.DEEPSEEK_BASE_URL;
    await mkdir(process.env.DSH_HOME, { recursive: true });
    runtimeBehavior.runError = undefined;
    runtimeBehavior.closeError = undefined;
    runtimeStateBehavior.blockCreationAtStart = false;
    runtimeStateBehavior.failBarrierPublication = false;
    runtimeStateBehavior.failPatchDisposal = false;
    runtimeBehavior.notifications = [];
    runtimeBehavior.startCount = 0;
    runtimeBehavior.runCount = 0;
    runtimeBehavior.closeCount = 0;
    runtimeBehavior.instanceCount = 0;
    runtimeBehavior.uniqueSessions = false;
    runtimeBehavior.confirmedExit = false;
    runtimeBehavior.runGate = undefined;
    runtimeBehavior.onClose = undefined;
  });

  afterEach(async () => {
    try {
      await closeDeepSeekHarnessProcesses().catch(() => undefined);
      await rm(temporaryRoot, { recursive: true, force: true });
    } finally {
      for (const key of environmentKeys) {
        const value = savedEnvironment.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      savedEnvironment.clear();
    }
  });

  it.each([
    [
      'JSON-RPC errors',
      new JsonRpcResponseError(-32000, `raw ${RAW_FAILURE_SENTINEL}`, { detail: RAW_FAILURE_SENTINEL }),
      AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
      'DeepSeek Harness runtime returned a JSON-RPC error. Upstream error details are withheld.',
    ],
    [
      'SDK protocol errors',
      new SdkProtocolError(`raw ${RAW_FAILURE_SENTINEL}`),
      AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR,
      'provider stream parse error: DeepSeek Harness SDK protocol validation failed',
    ],
    [
      'transport closure errors',
      new TransportClosedError(`runtime closed; stderr ${RAW_FAILURE_SENTINEL}`),
      AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
      'DeepSeek Harness runtime connection closed. Verify the runtime installation and retry. Upstream error details are withheld.',
    ],
    [
      'request timeout errors',
      new RequestTimeoutError(`request timed out; stderr ${RAW_FAILURE_SENTINEL}`),
      AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
      'part timeout: DeepSeek Harness SDK request timed out; the runtime was closed.',
    ],
  ] as const)('returns a fixed diagnostic for %s without exposing raw SDK data', async (_label, sdkError, category, expected) => {
    runtimeBehavior.runError = sdkError;
    const events: StreamEvent[] = [];
    const response = await callDeepSeekHarness('worker', 'trigger an SDK failure', {
      cwd: temporaryRoot,
      onStream: (event) => events.push(event),
    });

    expect(response).toMatchObject({ status: 'error', failureCategory: category, content: expected, error: expected });
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      data: { success: false, error: expected, result: expected, failureCategory: category },
    });
    expect(JSON.stringify({ response, events })).not.toContain(RAW_FAILURE_SENTINEL);
  });

  it('classifies the SDK duplicate-session response as unsupported continuation', async () => {
    runtimeBehavior.notifications = [{
      method: 'session.event',
      params: { sessionId: 'error-mapping-session', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
    }];
    const first = await callDeepSeekHarness('worker', 'create a live SDK session', { cwd: temporaryRoot });
    expect(first.status).toBe('done');
    const sessionId = first.sessionId!;
    runtimeBehavior.runError = new JsonRpcResponseError(-32603, `session "${sessionId}" already exists`);
    const response = await callDeepSeekHarness('worker', 'continue saved session', {
      cwd: temporaryRoot,
      sessionId,
    });

    expect(response).toMatchObject({
      status: 'error',
      sessionId,
      failureCategory: AGENT_FAILURE_CATEGORIES.SESSION_CONTINUATION_UNSUPPORTED,
      content: 'DeepSeek Harness cannot continue this session after runtime replacement or teardown; start a new TAKT session or run.',
    });
    expect(response.sessionId).toBe(sessionId);
    expect(response.content).not.toContain(sessionId);
    expect(runtimeBehavior.runCount).toBe(2);
  });

  it('does not classify a different SDK JSON-RPC error as duplicate session', async () => {
    runtimeBehavior.runError = new JsonRpcResponseError(-32603, 'invalid request');
    const response = await callDeepSeekHarness('worker', 'send an invalid request', {
      cwd: temporaryRoot,
    });

    expect(response).toMatchObject({
      status: 'error',
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
      content: 'DeepSeek Harness runtime returned a JSON-RPC error. Upstream error details are withheld.',
    });
    expect(response.content).not.toContain('invalid request');
    expect(runtimeBehavior.runCount).toBe(1);
  });

  it('maps SDK assistant/message text, reasoning, tool, and completion notifications to provider stream events', async () => {
    const sessionId = 'error-mapping-session';
    const event = (value: Record<string, unknown>) => ({
      method: 'session.event',
      params: { sessionId, event: value },
    });
    runtimeBehavior.notifications = [
      { method: 'session.started', params: { sessionId } },
      event({
        type: 'assistant/message',
        data: {
          message: {
            content: [
              { type: 'text', text: 'answer' },
              { type: 'reasoning', text: 'reasoning' },
              { type: 'tool-call', id: 'tool-call-1', name: 'Read', arguments: '{"file":"README.md"}' },
              {
                type: 'tool-result',
                toolCallId: 'tool-call-1',
                content: [{ type: 'text', text: 'README content' }],
                isError: false,
              },
            ],
          },
        },
      }),
      event({
        type: 'tool/call',
        data: { callId: 'tool-call-1', name: 'Read', arguments: '{"file":"README.md"}' },
      }),
      event({
        type: 'tool/result',
        data: {
          message: {
            source: { callId: 'tool-call-1' },
            content: [{
              type: 'tool-result',
              content: [{ type: 'text', text: 'README content' }],
              isError: false,
            }],
          },
        },
      }),
      event({ type: 'turn/end', data: { reason: { kind: 'completed' } } }),
    ];
    const events: StreamEvent[] = [];

    const response = await callDeepSeekHarness('worker', 'map SDK events', {
      cwd: temporaryRoot,
      onStream: (streamEvent) => events.push(streamEvent),
    });

    expect(response).toMatchObject({ status: 'done', content: 'ok', sessionId });
    expect(events.map((streamEvent) => streamEvent.type)).toEqual([
      'init',
      'text',
      'thinking',
      'tool_use',
      'tool_result',
      'result',
    ]);
    expect(events[1]?.data).toEqual({ text: 'answer' });
    expect(events[2]?.data).toEqual({ thinking: 'reasoning' });
    expect(events[3]?.data).toEqual({
      id: 'tool-call-1',
      tool: 'Read',
      input: { file: 'README.md' },
    });
    expect(events[4]?.data).toEqual({
      id: 'tool-call-1',
      content: 'README content',
      isError: false,
    });
  });

  it('reports cleanup failure with a fixed diagnostic and prevents later runtime creation', async () => {
    runtimeBehavior.runError = new JsonRpcResponseError(-32000, 'original failure');
    runtimeBehavior.closeError = new Error(`cleanup ${RAW_FAILURE_SENTINEL}`);
    runtimeBehavior.onClose = async () => {
      await writeFile(path.join(getDeepSeekRuntimePaths().owners, 'unconfirmed.json'), '{invalid');
    };
    const events: StreamEvent[] = [];
    const response = await callDeepSeekHarness('worker', 'trigger cleanup failure', {
      cwd: temporaryRoot,
      onStream: (event) => events.push(event),
    });

    const expected = deepSeekCleanupBlockedMessage();
    expect(response).toMatchObject({
      status: 'error',
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
      content: expected,
      error: expected,
    });
    expect(runtimeBehavior.startCount).toBe(1);
    expect(runtimeBehavior.runCount).toBe(1);
    expect(JSON.stringify({ response, events })).not.toContain(RAW_FAILURE_SENTINEL);
    await expect(callDeepSeekHarness('worker', 'must not overlap the uncleared runtime', {
      cwd: temporaryRoot,
    })).resolves.toMatchObject({
      status: 'error',
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
      content: expected,
    });
    expect(runtimeBehavior.startCount).toBe(1);
    expect(runtimeBehavior.runCount).toBe(1);
  });

  it('fails closed with a fixed diagnostic when shared runtime state cannot be read', async () => {
    const paths = getDeepSeekRuntimePaths();
    await mkdir(paths.state, { recursive: true });
    await writeFile(path.join(paths.state, 'cleanup-blocked'), '{invalid');
    let createCalled = false;

    await expect(withDeepSeekRuntimeCreation(async () => {
      createCalled = true;
    })).rejects.toBeInstanceOf(DeepSeekRuntimeCreationBlockedError);
    expect(createCalled).toBe(false);

    const response = await callDeepSeekHarness('worker', 'must fail before runtime creation', {
      cwd: temporaryRoot,
    });
    const expected = deepSeekCleanupBlockedMessage();
    expect(response).toMatchObject({
      status: 'error',
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
      content: expected,
      error: expected,
    });
    expect(runtimeBehavior.startCount).toBe(0);
    expect(runtimeBehavior.runCount).toBe(0);
  });

  it('fails closed when another process keeps the shared runtime state lock', async () => {
    const paths = getDeepSeekRuntimePaths();
    const lockDirectory = path.join(paths.state, '.runtime-state-lock');
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(path.join(lockDirectory, 'owner'), `${process.pid}\n`);

    try {
      const response = await callDeepSeekHarness('worker', 'must not start without the shared lock', {
        cwd: temporaryRoot,
      });
      const expected = deepSeekCleanupBlockedMessage();
      expect(response).toMatchObject({
        status: 'error',
        failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
        content: expected,
        error: expected,
      });
      expect(runtimeBehavior.startCount).toBe(0);
      expect(runtimeBehavior.runCount).toBe(0);
    } finally {
      await rm(lockDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it('preserves the cleanup diagnostic when the runtime start gate fails after provider setup', async () => {
    runtimeStateBehavior.blockCreationAtStart = true;

    const response = await callDeepSeekHarness('worker', 'fail at the runtime start gate', {
      cwd: temporaryRoot,
    });

    const expected = deepSeekCleanupBlockedMessage();
    expect(response).toMatchObject({
      status: 'error',
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
      content: expected,
      error: expected,
    });
    expect(runtimeBehavior.startCount).toBe(0);
    expect(runtimeBehavior.runCount).toBe(0);
  });

  it('does not persist an unknown-runtime barrier after an SDK close error with no remaining owners', async () => {
    runtimeBehavior.confirmedExit = true;
    runtimeBehavior.runError = new Error('SDK failure');
    runtimeBehavior.closeError = new Error('SDK close failure after process exit');
    expect((await callDeepSeekHarness('worker', 'first', { cwd: temporaryRoot })).status).toBe('error');
    await expect(readFile(path.join(getDeepSeekRuntimePaths().state, 'cleanup-blocked'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    runtimeBehavior.runError = undefined;
    runtimeBehavior.closeError = undefined;
    runtimeBehavior.uniqueSessions = true;
    expect((await callDeepSeekHarness('worker', 'new session', { cwd: temporaryRoot })).status).toBe('done');
  });

  it('keeps an empty registry fail-closed without supervisor exit confirmation', async () => {
    runtimeBehavior.runError = new Error('SDK failure');
    runtimeBehavior.closeError = new Error('SDK close failure with unpublished supervisor');
    expect((await callDeepSeekHarness('worker', 'first', { cwd: temporaryRoot })).status).toBe('error');
    const barrier = JSON.parse(await readFile(path.join(getDeepSeekRuntimePaths().state, 'cleanup-blocked'), 'utf8'));
    expect(barrier).toMatchObject({ unknownRuntime: true });
    const starts = runtimeBehavior.startCount;
    runtimeBehavior.closeError = undefined;
    runtimeBehavior.runError = undefined;
    expect((await callDeepSeekHarness('worker', 'must not overlap', { cwd: temporaryRoot })).status).toBe('error');
    expect(runtimeBehavior.startCount).toBe(starts);
  });

  it('bounds idle runtimes at eight and refuses evicted session IDs without silently replaying', async () => {
    runtimeBehavior.uniqueSessions = true;
    const sessions: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const result = await callDeepSeekHarness('worker', `fresh ${index}`, { cwd: temporaryRoot });
      expect(result.status).toBe('done');
      sessions.push(result.sessionId!);
    }
    expect((await callDeepSeekHarness('worker', 'touch oldest', { cwd: temporaryRoot, sessionId: sessions[0] })).status).toBe('done');
    expect((await callDeepSeekHarness('worker', 'ninth', { cwd: temporaryRoot })).status).toBe('done');
    expect(runtimeBehavior.closeCount).toBe(1);
    const runs = runtimeBehavior.runCount;
    expect(await callDeepSeekHarness('worker', 'evicted', { cwd: temporaryRoot, sessionId: sessions[1] }))
      .toMatchObject({ status: 'error', failureCategory: AGENT_FAILURE_CATEGORIES.SESSION_CONTINUATION_UNSUPPORTED });
    expect(runtimeBehavior.runCount).toBe(runs);
    expect((await callDeepSeekHarness('worker', 'still live', { cwd: temporaryRoot, sessionId: sessions[0] })).status).toBe('done');
  });

  it('does not evict active or queued turns when pruning idle runtimes', async () => {
    runtimeBehavior.uniqueSessions = true;
    const first = await callDeepSeekHarness('worker', 'first', { cwd: temporaryRoot });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    runtimeBehavior.runGate = async (prompt) => { if (prompt === 'hold') await gate; };
    const active = callDeepSeekHarness('worker', 'hold', { cwd: temporaryRoot, sessionId: first.sessionId });
    const turns = [active];
    try {
      await vi.waitFor(() => expect(runtimeBehavior.runCount).toBe(2), { timeout: 30_000 });
      const queued = callDeepSeekHarness('worker', 'queued', { cwd: temporaryRoot, sessionId: first.sessionId });
      turns.push(queued);
      for (let index = 0; index < 9; index += 1) {
        expect((await callDeepSeekHarness('worker', `fresh ${index}`, { cwd: temporaryRoot })).status).toBe('done');
      }
      release();
      expect((await active).status).toBe('done');
      expect((await queued).status).toBe('done');
    } finally {
      release();
      await Promise.allSettled(turns);
    }
    expect((await callDeepSeekHarness('worker', 'still live', { cwd: temporaryRoot, sessionId: first.sessionId })).status).toBe('done');
  });

  it('bounds the idle cache after simultaneous fresh-turn completions', async () => {
    runtimeBehavior.uniqueSessions = true;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    runtimeBehavior.runGate = () => gate;
    const turns = Array.from({ length: 12 }, (_, index) => callDeepSeekHarness('worker', `fresh ${index}`, { cwd: temporaryRoot }));
    try {
      await vi.waitFor(() => expect(runtimeBehavior.runCount).toBe(12), { timeout: 30_000 });
      release();
      expect((await Promise.all(turns)).every((turn) => turn.status === 'done')).toBe(true);
      expect(runtimeBehavior.closeCount).toBe(4);
    } finally {
      release();
      await Promise.allSettled(turns);
    }
  });

  it('preserves a completed turn when failed idle eviction has a confirmed quarantine barrier', async () => {
    runtimeBehavior.uniqueSessions = true;
    for (let index = 0; index < 8; index += 1) {
      expect((await callDeepSeekHarness('worker', `fresh ${index}`, { cwd: temporaryRoot })).status).toBe('done');
    }
    runtimeBehavior.closeError = new Error('unconfirmed cleanup');
    runtimeBehavior.onClose = async () => {
      await writeFile(path.join(getDeepSeekRuntimePaths().owners, 'unconfirmed.json'), '{invalid');
    };
    expect(await callDeepSeekHarness('worker', 'ninth', { cwd: temporaryRoot }))
      .toMatchObject({ status: 'done', content: 'ok' });
    expect(JSON.parse(await readFile(path.join(getDeepSeekRuntimePaths().state, 'cleanup-blocked'), 'utf8')))
      .toMatchObject({ unknownRuntime: true });
    const starts = runtimeBehavior.startCount;
    expect((await callDeepSeekHarness('worker', 'blocked', { cwd: temporaryRoot })).status).toBe('error');
    expect(runtimeBehavior.startCount).toBe(starts);
  });

  it('withholds completion when eviction cannot confirm barrier publication', async () => {
    runtimeBehavior.uniqueSessions = true;
    for (let index = 0; index < 8; index += 1) {
      expect((await callDeepSeekHarness('worker', `fresh ${index}`, { cwd: temporaryRoot })).status).toBe('done');
    }
    runtimeStateBehavior.failBarrierPublication = true;
    runtimeBehavior.closeError = new Error('unconfirmed cleanup');
    const events: StreamEvent[] = [];
    expect(await callDeepSeekHarness('worker', 'ninth', { cwd: temporaryRoot, onStream: (event) => { events.push(event); } }))
      .toMatchObject({ status: 'error', content: deepSeekCleanupBlockedMessage() });
    expect(events.some((event) => event.type === 'result' && event.data.success === true)).toBe(false);
    expect(runtimeBehavior.closeCount).toBeGreaterThan(1);
  });

  it('keeps a just-completed long turn live when newer short turns fill the idle cache', async () => {
    runtimeBehavior.uniqueSessions = true;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    runtimeBehavior.runGate = async (prompt) => { if (prompt === 'hold-first') await gate; };
    const longTurn = callDeepSeekHarness('worker', 'hold-first', { cwd: temporaryRoot });
    try {
      await vi.waitFor(() => expect(runtimeBehavior.runCount).toBe(1), { timeout: 30_000 });
      for (let index = 0; index < 8; index += 1) {
        expect((await callDeepSeekHarness('worker', `fresh ${index}`, { cwd: temporaryRoot })).status).toBe('done');
      }
      release();
      const completed = await longTurn;
      expect(completed.status).toBe('done');
      expect(runtimeBehavior.closeCount).toBe(1);
      expect((await callDeepSeekHarness('worker', 'continue completed', {
        cwd: temporaryRoot, sessionId: completed.sessionId,
      })).status).toBe('done');
    } finally {
      release();
      await Promise.allSettled([longTurn]);
    }
  });

  it('still bounds the idle cache when simultaneous evictions are durably quarantined', async () => {
    runtimeBehavior.uniqueSessions = true;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    runtimeBehavior.runGate = () => gate;
    runtimeBehavior.closeError = new Error('unconfirmed cleanup');
    const turns = Array.from({ length: 12 }, (_, index) => callDeepSeekHarness('worker', `fresh ${index}`, { cwd: temporaryRoot }));
    try {
      await vi.waitFor(() => expect(runtimeBehavior.runCount).toBe(12), { timeout: 30_000 });
      release();
      expect((await Promise.all(turns)).every((turn) => turn.status === 'done')).toBe(true);
      expect(runtimeBehavior.closeCount).toBe(4);
      const starts = runtimeBehavior.startCount;
      expect((await callDeepSeekHarness('worker', 'blocked', { cwd: temporaryRoot })).status).toBe('error');
      expect(runtimeBehavior.startCount).toBe(starts);
    } finally {
      release();
      await Promise.allSettled(turns);
    }
  });

  it('withholds completion when the evicted runtime credential patch cannot be disposed', async () => {
    runtimeBehavior.uniqueSessions = true;
    for (let index = 0; index < 8; index += 1) {
      expect((await callDeepSeekHarness('worker', `fresh ${index}`, { cwd: temporaryRoot })).status).toBe('done');
    }
    runtimeStateBehavior.failPatchDisposal = true;
    const events: StreamEvent[] = [];
    expect((await callDeepSeekHarness('worker', 'ninth', { cwd: temporaryRoot, onStream: (event) => { events.push(event); } })).status)
      .toBe('error');
    expect(events.some((event) => event.type === 'result' && event.data.success === true)).toBe(false);
    expect(runtimeBehavior.closeCount).toBeGreaterThan(1);
  });
});
