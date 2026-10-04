import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekHarness, HarnessClient, RequestTimeoutError, TransportClosedError, type DeepSeekHarnessOptions } from '@deepseek-ai/dsh-sdk-client';

const sdkConstructorOptions = vi.hoisted(() => [] as Array<DeepSeekHarnessOptions | undefined>);
vi.mock('@deepseek-ai/dsh-sdk-client', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@deepseek-ai/dsh-sdk-client')>();
  return {
    ...sdk,
    DeepSeekHarness: class extends sdk.DeepSeekHarness {
      /** Record SDK constructor options while retaining the real client implementation for process tests. */
      constructor(options?: DeepSeekHarnessOptions) {
        sdkConstructorOptions.push(options);
        super(options);
      }
    },
  };
});
import {
  callDeepSeekHarness,
  closeDeepSeekHarnessProcesses,
} from '../infra/deepseek-harness/index.js';
import { DeepSeekHarnessProvider } from '../infra/providers/deepseek-harness.js';
import {
  assertDeepSeekRuntimeCreationAllowed,
  getDeepSeekRuntimePaths,
  hasDeepSeekSessionMarker,
  markDeepSeekCleanupFailure,
  markDeepSeekSessionUsed,
  withDeepSeekRuntimeCreation,
} from '../infra/deepseek-harness/runtime-state.js';
import {
  markDeepSeekCleanupBarrierLocked,
  withDeepSeekRuntimeStateFileLock,
} from '../infra/deepseek-harness/runtime-state-lock.mjs';

interface ApiRequest {
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

interface LocalApi {
  endpoint: string;
  requests: ApiRequest[];
  setMode(mode: LocalApiMode): void;
  waitForFirstRequest(): Promise<void>;
  close(): Promise<void>;
}

type LocalApiMode = 'success' | 'credential-error' | 'credential-echo-after-success' | 'hold-response';

const SUPPORTED_RUNTIME = (
  (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64'))
  || (process.platform === 'darwin' && process.arch === 'arm64')
);
const DUMMY_CREDENTIAL = 'TAKT_DUMMY_CLIENT_CREDENTIAL_SENTINEL';
const environmentKeys = ['TAKT_CONFIG_DIR', 'DSH_HOME', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'] as const;
const savedEnvironment = new Map<string, string | undefined>();
let temporaryRoot: string;
let localApis: LocalApi[] = [];

/** Write one JSON-encoded SSE event to the local provider response. */
function writeSse(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Start a loopback provider with controlled success/error modes and observable requests; register it for teardown. */
async function startLocalApi(
  mode: LocalApiMode = 'success',
): Promise<LocalApi> {
  const requests: ApiRequest[] = [];
  let resolveFirstRequest: () => void = () => {};
  const firstRequestObserved = new Promise<void>((resolve) => {
    resolveFirstRequest = resolve;
  });
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      requests.push({ headers: request.headers, body });
      resolveFirstRequest();
      if (mode === 'hold-response') return;
      if (mode === 'credential-error' || (mode === 'credential-echo-after-success' && requests.length > 1)) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: `rejected ${String(request.headers['x-api-key'])}` },
        }));
        return;
      }
      const sequence = requests.length;
      response.writeHead(200, {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream',
      });
      writeSse(response, 'message_start', {
        type: 'message_start',
        message: {
          id: `client-message-${sequence}`,
          type: 'message',
          role: 'assistant',
          model: typeof body.model === 'string' ? body.model : 'deepseek-v4-flash',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      });
      writeSse(response, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      writeSse(response, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: `mock client response ${sequence}` },
      });
      writeSse(response, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      writeSse(response, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 2 },
      });
      writeSse(response, 'message_stop', { type: 'message_stop' });
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Local API mock did not bind');
  const api: LocalApi = {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    setMode: (next) => { mode = next; },
    waitForFirstRequest: () => firstRequestObserved,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
  localApis.push(api);
  return api;
}

/** Collect readable file contents for credential-leak assertions, treating a missing root as empty. */
async function readFiles(root: string): Promise<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
  let content = '';
  for (const entry of entries) {
    const path = join(root, entry.name);
    content += entry.isDirectory()
      ? await readFiles(path)
      : await readFile(path, 'utf8').catch(() => '');
  }
  return content;
}

/** Wait for a spawned parent to exit, including children that exited before the listener was attached. */
async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

/** Run an isolated parent with supplied environment, capture stdout, and bound its process-group lifetime. */
async function runSeparateParentProcess(
  script: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null; stdout: string; timedOut: boolean }> {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: environment,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let stdout = '';
  let timedOut = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  const timeout = setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined) {
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
      const forceKill = setTimeout(() => {
        try { process.kill(process.platform === 'win32' ? child.pid! : -child.pid!, 'SIGKILL'); } catch { /* Already exited. */ }
      }, 1_000);
      forceKill.unref?.();
    }
  }, 60_000);
  timeout.unref?.();
  return new Promise((resolve, reject) => {
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code, stdout, timedOut });
    });
  });
}

/** Wait until the separate parent publishes a marker; propagate non-ENOENT errors and fail at the deadline. */
async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the separate parent process marker');
}

describe('DeepSeek Harness TypeScript SDK client', () => {
  beforeEach(async () => {
    sdkConstructorOptions.length = 0;
    for (const key of environmentKeys) savedEnvironment.set(key, process.env[key]);
    temporaryRoot = await mkdtemp(join(tmpdir(), 'takt-deepseek-client-sdk-'));
    process.env.TAKT_CONFIG_DIR = join(temporaryRoot, 'takt');
    process.env.DSH_HOME = join(temporaryRoot, 'credential-source');
    process.env.DEEPSEEK_API_KEY = DUMMY_CREDENTIAL;
    delete process.env.DEEPSEEK_BASE_URL;
    await mkdir(process.env.DSH_HOME, { recursive: true });
  });

  afterEach(async () => {
    await closeDeepSeekHarnessProcesses().catch(() => undefined);
    vi.restoreAllMocks();
    for (const api of localApis.splice(0)) await api.close();
    await rm(temporaryRoot, { recursive: true, force: true });
    for (const key of environmentKeys) {
      const value = savedEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnvironment.clear();
  });

  it.skipIf(!SUPPORTED_RUNTIME)('keeps real SDK initialization, turn and shutdown deadlines independent', async () => {
    const api = await startLocalApi();
    const response = await callDeepSeekHarness('worker', 'Return ok.', {
      cwd: temporaryRoot,
      providerOptions: { baseUrl: api.endpoint, requestTimeoutMs: 5_000, shutdownTimeoutMs: 2_000 },
    });
    expect(response.status).toBe('done');
    expect(sdkConstructorOptions).toHaveLength(1);
    expect(sdkConstructorOptions[0]).toMatchObject({
      initializeTimeoutMs: 30_000, requestTimeoutMs: 5_000, shutdownTimeoutMs: 2_000,
    });
  });

  it.skipIf(!SUPPORTED_RUNTIME)('cleans up a real runtime when initialization fails with an SDK timeout', async () => {
    // SDK start() still spawns its real child. Inject the deadline failure at
    // the public handshake boundary, exercising SDK and TAKT failure cleanup.
    vi.spyOn(HarnessClient.prototype, 'initialize').mockRejectedValue(
      new RequestTimeoutError('RAW-INITIALIZE-TIMEOUT-SENTINEL'),
    );
    const close = vi.spyOn(DeepSeekHarness.prototype, 'close');
    const response = await callDeepSeekHarness('worker', 'Must not start a turn.', { cwd: temporaryRoot });
    expect(response.status).toBe('error');
    expect(JSON.stringify(response)).not.toContain('RAW-INITIALIZE-TIMEOUT-SENTINEL');
    expect(close).toHaveBeenCalled();
    const paths = getDeepSeekRuntimePaths();
    expect(await readdir(paths.owners)).toHaveLength(0);
    await expect(assertDeepSeekRuntimeCreationAllowed()).resolves.toBeUndefined();
  });

  it.skipIf(!SUPPORTED_RUNTIME)('binds a normal first turn to its live SDK session, serializes later turns FIFO, and refuses after teardown', async () => {
    const api = await startLocalApi();
    process.env.DEEPSEEK_BASE_URL = api.endpoint;
    const runtimePaths = getDeepSeekRuntimePaths();
    const workspace = join(temporaryRoot, 'workspace');
    await mkdir(workspace, { recursive: true });
    const initial = await callDeepSeekHarness('worker', 'initial prompt without an ID', {
      cwd: workspace,
      providerOptions: { reasoningEffort: 'low', baseUrl: api.endpoint },
    });
    expect(initial).toMatchObject({ status: 'done', content: 'mock client response 1' });
    expect(initial.sessionId).toEqual(expect.any(String));
    const sessionId = initial.sessionId!;
    const streamEvents: unknown[][] = [[], []];

    const [first, second] = await Promise.all([
      callDeepSeekHarness('worker', 'first queued prompt', {
        cwd: workspace,
        sessionId,
        providerOptions: { reasoningEffort: 'low', baseUrl: api.endpoint },
        onStream: (event) => streamEvents[0]?.push(event),
      }),
      callDeepSeekHarness('worker', 'second queued prompt', {
        cwd: workspace,
        sessionId,
        providerOptions: { reasoningEffort: 'low', baseUrl: api.endpoint },
        onStream: (event) => streamEvents[1]?.push(event),
      }),
    ]);

    expect(first).toMatchObject({ status: 'done', content: 'mock client response 2', sessionId });
    expect(second).toMatchObject({ status: 'done', content: 'mock client response 3', sessionId });
    expect(api.requests).toHaveLength(3);
    expect(api.requests.map((request) => request.headers['x-api-key'])).toEqual([
      DUMMY_CREDENTIAL, DUMMY_CREDENTIAL, DUMMY_CREDENTIAL,
    ]);
    const histories = api.requests.map((request) => JSON.stringify(request.body.messages));
    expect(histories[0]).toContain('initial prompt without an ID');
    expect(histories[1]).toContain('initial prompt without an ID');
    expect(histories[1]).toContain('first queued prompt');
    expect(histories[1]).not.toContain('second queued prompt');
    expect(histories[2]).toContain('initial prompt without an ID');
    expect(histories[2]).toContain('mock client response 2');
    expect(histories[2]).toContain('first queued prompt');
    expect(histories[2]).toContain('second queued prompt');
    expect(streamEvents[0]?.some((event) => JSON.stringify(event).includes('mock client response 2'))).toBe(true);
    expect(streamEvents[1]?.some((event) => JSON.stringify(event).includes('mock client response 3'))).toBe(true);
    expect(runtimePaths.dshHome).not.toBe(process.env.DSH_HOME);
    expect(await readFiles(runtimePaths.dshHome)).not.toContain(DUMMY_CREDENTIAL);

    await closeDeepSeekHarnessProcesses();
    const refused = await callDeepSeekHarness('worker', 'must not restart', {
      cwd: workspace,
      sessionId,
      providerOptions: { reasoningEffort: 'low', baseUrl: api.endpoint },
    });
    expect(refused.status).toBe('error');
    expect(refused.failureCategory).toBe('session_continuation_unsupported');
    expect(refused.content).toBe(
      'DeepSeek Harness cannot continue this session after runtime replacement or teardown; start a new TAKT session or run.',
    );
    expect(api.requests).toHaveLength(3);
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME)('refuses the same session ID after a failed turn tears down its runtime', async () => {
    const api = await startLocalApi();
    process.env.DEEPSEEK_BASE_URL = api.endpoint;
    const workspace = join(temporaryRoot, 'failed-turn-workspace');
    await mkdir(workspace, { recursive: true });
    const options = {
      cwd: workspace,
      providerOptions: { requestTimeoutMs: 30_000, baseUrl: api.endpoint },
    };
    const initial = await callDeepSeekHarness('worker', 'start a live session', options);
    expect(initial).toMatchObject({ status: 'done', sessionId: expect.any(String) });
    const sessionId = initial.sessionId!;
    api.setMode('credential-error');
    const failed = await callDeepSeekHarness('worker', 'fail the authenticated turn', { ...options, sessionId });
    const refused = await callDeepSeekHarness('worker', 'must not resume the failed turn', { ...options, sessionId });

    expect(failed.status).not.toBe('done');
    expect(api.requests).toHaveLength(2);
    expect(refused).toMatchObject({
      status: 'error',
      failureCategory: 'session_continuation_unsupported',
      content: 'DeepSeek Harness cannot continue this session after runtime replacement or teardown; start a new TAKT session or run.',
    });
    expect(api.requests).toHaveLength(2);
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME)('refuses the same session ID after an active turn is aborted and its runtime is torn down', async () => {
    const api = await startLocalApi();
    process.env.DEEPSEEK_BASE_URL = api.endpoint;
    const workspace = join(temporaryRoot, 'aborted-turn-workspace');
    await mkdir(workspace, { recursive: true });
    const abortController = new AbortController();
    const continuationOptions = {
      cwd: workspace,
      providerOptions: { requestTimeoutMs: 30_000, baseUrl: api.endpoint },
    };
    const initial = await callDeepSeekHarness('worker', 'start before aborting', continuationOptions);
    expect(initial).toMatchObject({ status: 'done', sessionId: expect.any(String) });
    const sessionId = initial.sessionId!;
    api.setMode('hold-response');
    const abortedTurn = callDeepSeekHarness('worker', 'abort the active model request', {
      ...continuationOptions,
      sessionId,
      abortSignal: abortController.signal,
    });
    await vi.waitFor(() => expect(api.requests).toHaveLength(2), { timeout: 10_000, interval: 25 });
    abortController.abort(new Error('test aborted active DeepSeek turn'));

    const aborted = await abortedTurn;
    const refused = await callDeepSeekHarness('worker', 'must not resume the aborted turn', { ...continuationOptions, sessionId });

    expect(aborted.failureCategory).toBe('external_abort');
    expect(api.requests).toHaveLength(2);
    expect(refused).toMatchObject({
      status: 'error',
      failureCategory: 'session_continuation_unsupported',
      content: 'DeepSeek Harness cannot continue this session after runtime replacement or teardown; start a new TAKT session or run.',
    });
    expect(api.requests).toHaveLength(2);
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME)('applies per-call effort to a new session and refuses changing it for a live session', async () => {
    const api = await startLocalApi();
    process.env.DEEPSEEK_BASE_URL = api.endpoint;
    const workspace = join(temporaryRoot, 'effort-workspace');
    await mkdir(workspace, { recursive: true });
    const agent = new DeepSeekHarnessProvider().setup({ name: 'worker' });
    const callOptions = (sessionId: string | undefined, effort?: 'low' | 'high') => ({
      cwd: workspace,
      model: 'deepseek-v4-flash',
      sessionId,
      ...(effort === undefined ? {} : { effort }),
    });

    const first = await agent.call('first effort-bound turn', {
      ...callOptions(undefined, 'low'),
    });
    const changed = await agent.call('must not run with changed effort', {
      ...callOptions(first.sessionId, 'high'),
    });
    const removed = await agent.call('must not run after removing explicit effort', {
      ...callOptions(first.sessionId),
    });
    const newSession = await agent.call('new session uses requested effort', {
      ...callOptions(undefined, 'high'),
    });

    expect(first).toMatchObject({ status: 'done', sessionId: expect.any(String) });
    expect(changed).toMatchObject({
      status: 'error',
      failureCategory: 'session_continuation_unsupported',
      content: 'DeepSeek Harness cannot continue this session after runtime replacement or teardown; start a new TAKT session or run.',
    });
    expect(removed).toMatchObject({
      status: 'error',
      failureCategory: 'session_continuation_unsupported',
      content: 'DeepSeek Harness cannot continue this session after runtime replacement or teardown; start a new TAKT session or run.',
    });
    expect(newSession).toMatchObject({ status: 'done', sessionId: expect.any(String) });
    expect(newSession.sessionId).not.toBe(first.sessionId);
    expect(api.requests).toHaveLength(2);
    expect(api.requests.map((request) => request.body.model)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-flash',
    ]);
    expect(api.requests.map((request) => (
      (request.body.output_config as Record<string, unknown> | undefined)?.effort
    ))).toEqual(['low', 'high']);
    await closeDeepSeekHarnessProcesses();
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME)('refuses changing the model for a live session and applies it to a new session', async () => {
    const api = await startLocalApi();
    process.env.DEEPSEEK_BASE_URL = api.endpoint;
    const workspace = join(temporaryRoot, 'model-change-workspace');
    await mkdir(workspace, { recursive: true });

    const call = (sessionId: string | undefined, model: string) => callDeepSeekHarness('worker', `run with ${model}`, {
      cwd: workspace,
      model,
      sessionId,
      providerOptions: { baseUrl: api.endpoint, reasoningEffort: 'low' },
    });

    const first = await call(undefined, 'deepseek-v4-flash');
    const changed = await call(first.sessionId, 'deepseek-v4-pro');
    const newSession = await call(undefined, 'deepseek-v4-pro');

    expect(first).toMatchObject({ status: 'done', sessionId: expect.any(String) });
    expect(changed).toMatchObject({
      status: 'error',
      failureCategory: 'session_continuation_unsupported',
      content: 'DeepSeek Harness cannot continue this session after runtime replacement or teardown; start a new TAKT session or run.',
    });
    expect(newSession).toMatchObject({ status: 'done', sessionId: expect.any(String) });
    expect(newSession.sessionId).not.toBe(first.sessionId);
    expect(api.requests.map((request) => request.body.model)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ]);
    await closeDeepSeekHarnessProcesses();
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME)('refuses a previously used session ID after the parent process restarts', async () => {
    const api = await startLocalApi();
    process.env.DEEPSEEK_BASE_URL = api.endpoint;
    const workspace = join(temporaryRoot, 'restart-workspace');
    await mkdir(workspace, { recursive: true });
    const clientModuleUrl = new URL('../infra/deepseek-harness/index.js', import.meta.url).href;
    const testEnvironment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: join(temporaryRoot, 'child-home'),
      TAKT_CONFIG_DIR: process.env.TAKT_CONFIG_DIR,
      DSH_HOME: process.env.DSH_HOME,
      DEEPSEEK_API_KEY: DUMMY_CREDENTIAL,
      DEEPSEEK_BASE_URL: api.endpoint,
      TEST_WORKSPACE: workspace,
      NO_COLOR: '1',
    };
    const firstRunScript = [
      `const client = await import(${JSON.stringify(clientModuleUrl)});`,
      'let response;',
      'try { response = await client.callDeepSeekHarness(\'worker\', \'persist this test session\', { cwd: process.env.TEST_WORKSPACE }); }',
      'finally { await client.closeDeepSeekHarnessProcesses(); }',
      'process.stdout.write(JSON.stringify(response));',
    ].join('\n');
    const firstRun = await runSeparateParentProcess(firstRunScript, testEnvironment);
    expect(firstRun.timedOut).toBe(false);
    expect(firstRun.exitCode).toBe(0);
    const initialResponse: { status: string; sessionId?: string } = JSON.parse(firstRun.stdout);
    expect(initialResponse).toMatchObject({ status: 'done', sessionId: expect.any(String) });
    expect(api.requests).toHaveLength(1);

    const restartScript = [
      `const client = await import(${JSON.stringify(clientModuleUrl)});`,
      `const response = await client.callDeepSeekHarness('worker', 'must not restart persisted session', { cwd: process.env.TEST_WORKSPACE, sessionId: ${JSON.stringify(initialResponse.sessionId)} });`,
      'process.stdout.write(JSON.stringify(response));',
    ].join('\n');
    const restart = await runSeparateParentProcess(restartScript, testEnvironment);
    expect(restart.timedOut).toBe(false);
    expect(restart.exitCode).toBe(0);
    expect(JSON.parse(restart.stdout)).toMatchObject({
      status: 'error',
      failureCategory: 'session_continuation_unsupported',
      content: expect.stringContaining('start a new TAKT session or run'),
    });
    expect(api.requests).toHaveLength(1);
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME)('withholds credential values from SDK authentication failures and provider events', async () => {
    const api = await startLocalApi('credential-error');
    process.env.DEEPSEEK_BASE_URL = api.endpoint;
    const events: unknown[] = [];
    const response = await callDeepSeekHarness('worker', 'trigger a rejected request', {
      cwd: temporaryRoot,
      onStream: (event) => events.push(event),
    });

    expect(response.status).toBe('error');
    expect(JSON.stringify(response)).not.toContain(DUMMY_CREDENTIAL);
    expect(JSON.stringify(events)).not.toContain(DUMMY_CREDENTIAL);
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.headers['x-api-key']).toBe(DUMMY_CREDENTIAL);
  }, 60_000);

  it.skipIf(!SUPPORTED_RUNTIME)('withholds a credential echoed after a successful turn from provider events and stored sessions', async () => {
    const api = await startLocalApi('credential-echo-after-success');
    process.env.DEEPSEEK_BASE_URL = api.endpoint;
    const events: unknown[] = [];
    const options = {
      cwd: temporaryRoot,
      onStream: (event: unknown) => events.push(event),
    };
    const first = await callDeepSeekHarness('worker', 'complete before the rejected request', options);
    const second = await callDeepSeekHarness('worker', 'trigger the credential echo', { ...options, sessionId: first.sessionId });
    const savedSessions = await readFiles(getDeepSeekRuntimePaths().dshHome);

    expect(first.status).toBe('done');
    expect(second.status).toBe('error');
    expect(api.requests).toHaveLength(2);
    expect(api.requests.every((request) => request.headers['x-api-key'] === DUMMY_CREDENTIAL)).toBe(true);
    expect(JSON.stringify(second)).not.toContain(DUMMY_CREDENTIAL);
    expect(JSON.stringify(events)).not.toContain(DUMMY_CREDENTIAL);
    expect(savedSessions).not.toContain(DUMMY_CREDENTIAL);
  }, 60_000);

  it('persists only a digest of a session ID and detects the marker after local state is discarded', async () => {
    const sessionId = 'marker-private-session-id';
    expect(await markDeepSeekSessionUsed(sessionId)).toBe(true);
    expect(await markDeepSeekSessionUsed(sessionId)).toBe(false);
    const paths = getDeepSeekRuntimePaths();
    expect(await hasDeepSeekSessionMarker(sessionId)).toBe(true);
    const markerNames = await readdir(paths.sessions);
    expect(markerNames).toHaveLength(1);
    expect(markerNames[0]).not.toContain(sessionId);
  });

  it('serializes a different-session runtime start behind cleanup failure publication', async () => {
    let releaseSessionA: () => void = () => {};
    let signalSessionAStarted: () => void = () => {};
    const sessionAStarted = new Promise<void>((resolve) => { signalSessionAStarted = resolve; });
    const sessionAStartBarrier = new Promise<void>((resolve) => { releaseSessionA = resolve; });
    let runtimeStartCount = 0;

    const sessionAStart = withDeepSeekRuntimeCreation(async () => {
      runtimeStartCount += 1;
      await writeFile(join(getDeepSeekRuntimePaths().owners, 'unconfirmed.json'), '{invalid');
      signalSessionAStarted();
      await sessionAStartBarrier;
    });
    await sessionAStarted;

    const cleanupFailurePublication = markDeepSeekCleanupFailure();
    const sessionBStart = withDeepSeekRuntimeCreation(async () => {
      runtimeStartCount += 1;
    });

    releaseSessionA();
    await sessionAStart;
    await cleanupFailurePublication;
    await expect(sessionBStart).rejects.toThrow(
      'then manually remove .runtime-state-lock and cleanup-blocked',
    );
    expect(runtimeStartCount).toBe(1);
  });

  it.skipIf(!SUPPORTED_RUNTIME)('rechecks cleanup barriers at the SDK spawn gate across parent processes', async () => {
    const runtimePaths = getDeepSeekRuntimePaths();
    const workspace = join(temporaryRoot, 'cross-parent-workspace');
    await mkdir(workspace, { recursive: true });
    const clientModuleUrl = new URL('../infra/deepseek-harness/runtime-state.js', import.meta.url).href;
    const credentialBindingModuleUrl = new URL('../infra/deepseek-harness/credential-binding.js', import.meta.url).href;
    const credentialPatchModuleUrl = new URL('../infra/deepseek-harness/credential-patch.js', import.meta.url).href;
    const supervisorPath = fileURLToPath(new URL('../infra/deepseek-harness/runtime-supervisor.mjs', import.meta.url));
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: join(temporaryRoot, 'cross-parent-home'),
      TAKT_CONFIG_DIR: process.env.TAKT_CONFIG_DIR,
      DSH_HOME: process.env.DSH_HOME,
      DEEPSEEK_API_KEY: DUMMY_CREDENTIAL,
      TEST_WORKSPACE: workspace,
      TEST_RUNTIME_SUPERVISOR: supervisorPath,
      NO_COLOR: '1',
    };
    const createStartScript = (readyFile?: string, continueFile?: string): string => [
      `const state = await import(${JSON.stringify(clientModuleUrl)});`,
      `const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client');`,
      `const { resolveDeepSeekCredentialBinding } = await import(${JSON.stringify(credentialBindingModuleUrl)});`,
      `const { createDeepSeekCredentialPatch } = await import(${JSON.stringify(credentialPatchModuleUrl)});`,
      `const { homedir } = await import('node:os');`,
      `const { readdir, readFile, writeFile } = await import('node:fs/promises');`,
      `const paths = state.getDeepSeekRuntimePaths();`,
      `await state.assertDeepSeekRuntimeCreationAllowed();`,
      ...(readyFile === undefined ? [] : [
        `await writeFile(${JSON.stringify(readyFile)}, 'ready');`,
        `const continueFile = ${JSON.stringify(continueFile)};`,
        'const deadline = Date.now() + 10000;',
        'while (Date.now() < deadline) {',
        '  try { await readFile(continueFile); break; }',
        '  catch (error) { if (error.code !== \'ENOENT\') throw error; }',
        '  await new Promise((resolve) => setTimeout(resolve, 10));',
        '}',
        'if (Date.now() >= deadline) throw new Error(\'Timed out waiting to continue\');',
      ]),
      'const binding = await resolveDeepSeekCredentialBinding({',
      '  childProcessEnv: process.env,',
      '  ambientEnv: process.env,',
      '  userHome: homedir(),',
      '});',
      'const credentialPatch = await createDeepSeekCredentialPatch(binding);',
      'const harness = new DeepSeekHarness({',
      '  dshBin: process.env.TEST_RUNTIME_SUPERVISOR,',
      "  profile: 'sdk',",
      "  patches: [credentialPatch.path],",
      '  dshHome: paths.dshHome,',
      '  processCwd: process.env.TEST_WORKSPACE,',
      "  provider: 'deepseek-official',",
      "  model: 'deepseek-v4-flash',",
      '  env: {',
      '    ...process.env,',
      '    TAKT_DSH_OWNER_DIRECTORY: paths.owners,',
      '    TAKT_DSH_STATE_DIRECTORY: paths.state,',
      '    TAKT_DSH_PARENT_PID: String(process.pid),',
      '  },',
      '});',
      'let started = false;',
      'let blocked = false;',
      'let ownerCount = 0;',
      'try {',
      '  await harness.start();',
      '  started = true;',
      '  ownerCount = (await readdir(paths.owners)).length;',
      '} catch {',
      '  try { await state.assertDeepSeekRuntimeCreationAllowed(); }',
      '  catch { blocked = true; }',
      '}',
      'await harness.close().catch(() => undefined);',
      'await credentialPatch.dispose();',
      'process.stdout.write(JSON.stringify({',
      '  started,',
      '  blocked,',
      '  ownerCount,',
      '  diagnostic: blocked ? state.deepSeekCleanupBlockedMessage() : undefined,',
      '}));',
    ].join('\n');

    const normalStart = await runSeparateParentProcess(createStartScript(), environment);
    expect(normalStart.timedOut).toBe(false);
    expect(normalStart.exitCode).toBe(0);
    expect(JSON.parse(normalStart.stdout)).toMatchObject({ started: true, blocked: false, ownerCount: 1 });

    const readyFile = join(temporaryRoot, 'parent-a-ready');
    const continueFile = join(temporaryRoot, 'parent-a-continue');
    const parentA = runSeparateParentProcess(createStartScript(readyFile, continueFile), environment);
    await waitForFile(readyFile, 10_000);
    const stateModuleUrl = new URL('../infra/deepseek-harness/runtime-state.js', import.meta.url).href;
    const parentB = await runSeparateParentProcess([
      `const state = await import(${JSON.stringify(stateModuleUrl)});`,
      `const { writeFile, rm } = await import('node:fs/promises');`,
      `await writeFile(${JSON.stringify(join(runtimePaths.owners, 'unconfirmed.json'))}, '{invalid');`,
      'await state.markDeepSeekCleanupFailure();',
      `await rm(${JSON.stringify(join(runtimePaths.owners, 'unconfirmed.json'))});`,
      `await writeFile(${JSON.stringify(continueFile)}, 'published');`,
    ].join('\n'), environment);
    expect(parentB.timedOut).toBe(false);
    expect(parentB.exitCode).toBe(0);
    const racedStart = await parentA;
    expect(racedStart.timedOut).toBe(false);
    expect(racedStart.exitCode).toBe(0);
    expect(JSON.parse(racedStart.stdout)).toEqual({
      started: false,
      blocked: true,
      ownerCount: 0,
      diagnostic: expect.stringContaining('then manually remove .runtime-state-lock and cleanup-blocked'),
    });
    expect(await readdir(runtimePaths.owners)).toHaveLength(0);

    const providerResponse = await callDeepSeekHarness('worker', 'must not overlap the failed cleanup', {
      cwd: workspace,
    });
    expect(providerResponse).toMatchObject({
      status: 'error',
      failureCategory: 'provider_error',
      content: expect.stringContaining('then manually remove .runtime-state-lock and cleanup-blocked'),
    });
    expect(await readdir(runtimePaths.owners)).toHaveLength(0);
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME)('does not release the startup lock before an unregistered runtime exits', async () => {
    const paths = getDeepSeekRuntimePaths();
    const unsafeRelease = join(temporaryRoot, 'unsafe-startup-lock-release');
    const supervisorUrl = new URL('../infra/deepseek-harness/runtime-supervisor.mjs', import.meta.url).href;
    const script = [
      "const fs = (await import('node:fs')).default;",
      "const childProcess = (await import('node:child_process')).default;",
      "const { syncBuiltinESMExports } = await import('node:module');",
      "const { join } = await import('node:path');",
      'const originalSpawn = childProcess.spawn;',
      'const originalRename = fs.promises.rename;',
      'const originalRm = fs.promises.rm;',
      'let runtime;',
      'childProcess.spawn = (command, args, options) => {',
      "  runtime = originalSpawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)'], options);",
      '  return runtime;',
      '};',
      'fs.promises.rename = async (from, to) => {',
      "  if (to === join(process.env.TAKT_DSH_OWNER_DIRECTORY, `${process.pid}.json`)) throw new Error('injected owner publication failure');",
      '  return originalRename(from, to);',
      '};',
      'fs.promises.rm = async (target, options) => {',
      "  if (target === join(process.env.TAKT_DSH_STATE_DIRECTORY, '.runtime-state-lock') && runtime?.pid !== undefined) {",
      '    let groupAlive = true;',
      "    try { process.kill(-runtime.pid, 0); } catch (error) { groupAlive = error.code !== 'ESRCH'; }",
      `    if (groupAlive) fs.appendFileSync(${JSON.stringify(unsafeRelease)}, 'released while unregistered group alive\\n');`,
      '  }',
      '  return originalRm(target, options);',
      '};',
      'syncBuiltinESMExports();',
      `await import(${JSON.stringify(supervisorUrl)});`,
    ].join('\n');
    const result = await runSeparateParentProcess(script, {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: join(temporaryRoot, 'startup-failure-home'),
      TAKT_DSH_OWNER_DIRECTORY: paths.owners,
      TAKT_DSH_STATE_DIRECTORY: paths.state,
      TAKT_DSH_PARENT_PID: String(process.pid),
      NO_COLOR: '1',
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(70);
    expect(existsSync(unsafeRelease)).toBe(false);
    expect(await readdir(paths.owners)).toEqual([]);
    await expect(assertDeepSeekRuntimeCreationAllowed()).resolves.toBeUndefined();
  }, 30_000);

  it.skipIf(!SUPPORTED_RUNTIME)('rejects a cleanup-failed owner at the SDK spawn gate', async () => {
    const runtimePaths = getDeepSeekRuntimePaths();
    await mkdir(runtimePaths.owners, { recursive: true });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    if (child.pid === undefined) throw new Error('Cleanup-failed runtime did not start');
    const ownerPath = join(runtimePaths.owners, 'cleanup-failed-runtime.json');
    await writeFile(ownerPath, JSON.stringify({
      parentPid: process.pid,
      supervisorPid: process.pid,
      runtimePid: child.pid,
      cleanupFailed: true,
    }));
    const clientModuleUrl = new URL('../infra/deepseek-harness/runtime-state.js', import.meta.url).href;
    const credentialBindingModuleUrl = new URL('../infra/deepseek-harness/credential-binding.js', import.meta.url).href;
    const credentialPatchModuleUrl = new URL('../infra/deepseek-harness/credential-patch.js', import.meta.url).href;
    const supervisorPath = fileURLToPath(new URL('../infra/deepseek-harness/runtime-supervisor.mjs', import.meta.url));
    const script = [
      `const state = await import(${JSON.stringify(clientModuleUrl)});`,
      `const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client');`,
      `const { resolveDeepSeekCredentialBinding } = await import(${JSON.stringify(credentialBindingModuleUrl)});`,
      `const { createDeepSeekCredentialPatch } = await import(${JSON.stringify(credentialPatchModuleUrl)});`,
      `const { homedir } = await import('node:os');`,
      `const paths = state.getDeepSeekRuntimePaths();`,
      'const binding = await resolveDeepSeekCredentialBinding({',
      '  childProcessEnv: process.env,',
      '  ambientEnv: process.env,',
      '  userHome: homedir(),',
      '});',
      'const credentialPatch = await createDeepSeekCredentialPatch(binding);',
      'const harness = new DeepSeekHarness({',
      `  dshBin: ${JSON.stringify(supervisorPath)},`,
      "  profile: 'sdk',",
      '  patches: [credentialPatch.path],',
      '  dshHome: paths.dshHome,',
      '  processCwd: process.cwd(),',
      "  provider: 'deepseek-official',",
      "  model: 'deepseek-v4-flash',",
      '  env: {',
      '    ...process.env,',
      '    TAKT_DSH_OWNER_DIRECTORY: paths.owners,',
      '    TAKT_DSH_STATE_DIRECTORY: paths.state,',
      '    TAKT_DSH_PARENT_PID: String(process.pid),',
      '  },',
      '});',
      'let started = false;',
      'let blocked = false;',
      'try { await harness.start(); started = true; }',
      'catch { try { await state.assertDeepSeekRuntimeCreationAllowed(); } catch { blocked = true; } }',
      'await harness.close().catch(() => undefined);',
      'await credentialPatch.dispose();',
      'process.stdout.write(JSON.stringify({ started, blocked }));',
    ].join('\n');
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: join(temporaryRoot, 'cleanup-owner-home'),
      TAKT_CONFIG_DIR: process.env.TAKT_CONFIG_DIR,
      DSH_HOME: process.env.DSH_HOME,
      DEEPSEEK_API_KEY: DUMMY_CREDENTIAL,
      NO_COLOR: '1',
    };

    try {
      const result = await runSeparateParentProcess(script, environment);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ started: false, blocked: true });
    } finally {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
      await waitForExit(child);
      await rm(ownerPath, { force: true });
    }
  }, 90_000);

  it('returns the fixed cleanup diagnostic when the supervisor rejects after the provider gate', async () => {
    const runtimePaths = getDeepSeekRuntimePaths();
    const workspace = join(temporaryRoot, 'supervisor-gate-workspace');
    await mkdir(workspace, { recursive: true });
    vi.spyOn(DeepSeekHarness.prototype, 'start').mockImplementation(async () => {
      await withDeepSeekRuntimeStateFileLock(runtimePaths.state, () =>
        writeFile(join(runtimePaths.state, 'cleanup-blocked'), '{invalid'));
      throw new TransportClosedError('SDK-RAW-TEST-DIAGNOSTIC');
    });
    vi.spyOn(DeepSeekHarness.prototype, 'close').mockResolvedValue(undefined);

    const response = await callDeepSeekHarness('worker', 'provider cleanup boundary', {
      cwd: workspace,
    });

    expect(response).toMatchObject({
      status: 'error',
      failureCategory: 'provider_error',
      content: expect.stringContaining('then manually remove .runtime-state-lock and cleanup-blocked'),
    });
    expect(JSON.stringify(response)).not.toContain('SDK-RAW-TEST-DIAGNOSTIC');
    expect(await readdir(runtimePaths.owners)).toHaveLength(0);
  });

  it.skipIf(!SUPPORTED_RUNTIME)('uses supervisor exit proof when SDK close rejects after actual group cleanup', async () => {
    const api = await startLocalApi();
    const options = { cwd: temporaryRoot, providerOptions: { reasoningEffort: 'low' as const, baseUrl: api.endpoint } };
    expect((await callDeepSeekHarness('worker', 'first live runtime', options)).status).toBe('done');
    const originalClose = DeepSeekHarness.prototype.close;
    const closeSpy = vi.spyOn(DeepSeekHarness.prototype, 'close').mockImplementation(async function (this: DeepSeekHarness) {
      await originalClose.call(this);
      throw new Error('SDK close rejected after confirmed process exit');
    });
    await expect(closeDeepSeekHarnessProcesses()).resolves.toBeUndefined();
    expect(await readdir(getDeepSeekRuntimePaths().owners)).toHaveLength(0);
    await expect(readFile(join(getDeepSeekRuntimePaths().state, 'cleanup-blocked'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    closeSpy.mockRestore();
    expect((await callDeepSeekHarness('worker', 'new live runtime', options)).status).toBe('done');
  }, 60_000);

  it.skipIf(process.platform === 'win32')('keeps a global cleanup barrier until the failed process group is confirmed stopped', async () => {
    const runtimePaths = getDeepSeekRuntimePaths();
    await mkdir(runtimePaths.owners, { recursive: true });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    if (child.pid === undefined) throw new Error('Child runtime did not start');
    const ownerPath = join(runtimePaths.owners, 'failed-cleanup-runtime.json');
    await writeFile(ownerPath, JSON.stringify({
      parentPid: process.pid,
      supervisorPid: process.pid,
      runtimePid: child.pid,
      cleanupFailed: true,
    }));
    await markDeepSeekCleanupFailure();
    await expect(assertDeepSeekRuntimeCreationAllowed()).rejects.toThrow(
      'then manually remove .runtime-state-lock and cleanup-blocked',
    );
    expect(await readFile(join(runtimePaths.state, 'cleanup-blocked'), 'utf8')).toContain(String(child.pid));
    try {
      process.kill(-child.pid, 'SIGTERM');
      await waitForExit(child);
      await assertDeepSeekRuntimeCreationAllowed();
      await expect(readFile(ownerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      }
    }
  });

  it.each(['malformed', 'directory', 'insufficient', 'missing-live-pid'] as const)(
    'does not confirm an existing %s cleanup barrier and retains the startup lock',
    async (kind) => {
      const paths = getDeepSeekRuntimePaths();
      await mkdir(paths.state, { recursive: true });
      const barrier = join(paths.state, 'cleanup-blocked');
      if (kind === 'directory') await mkdir(barrier);
      else await writeFile(barrier, kind === 'malformed'
        ? '{invalid'
        : JSON.stringify({ runtimePids: [], unknownRuntime: false }));
      if (kind === 'missing-live-pid') {
        await mkdir(paths.owners, { recursive: true });
        await writeFile(join(paths.owners, 'known-runtime.json'), JSON.stringify({
          parentPid: process.pid, supervisorPid: process.pid, runtimePid: process.pid,
        }));
      }
      await expect(markDeepSeekCleanupFailure()).rejects.toThrow('cleanup is unconfirmed');
      expect(existsSync(join(paths.state, '.runtime-state-lock'))).toBe(true);
    },
  );

  it('confirms an existing valid unknown-runtime quarantine barrier', async () => {
    const paths = getDeepSeekRuntimePaths();
    await mkdir(paths.state, { recursive: true });
    await writeFile(join(paths.state, 'cleanup-blocked'), JSON.stringify({ runtimePids: [], unknownRuntime: true }));
    await expect(markDeepSeekCleanupFailure()).resolves.toBeUndefined();
    expect(existsSync(join(paths.state, '.runtime-state-lock'))).toBe(false);
    await expect(assertDeepSeekRuntimeCreationAllowed()).rejects.toThrow('cleanup is unconfirmed');
  });

  it.skipIf(process.platform === 'win32')('blocks runtime creation while an unowned process group remains alive', async () => {
    const runtimePaths = getDeepSeekRuntimePaths();
    await mkdir(runtimePaths.owners, { recursive: true });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    if (child.pid === undefined) throw new Error('Child runtime did not start');
    const ownerPath = join(runtimePaths.owners, 'orphaned-runtime.json');
    await writeFile(ownerPath, JSON.stringify({
      parentPid: process.pid + 100_000,
      supervisorPid: process.pid + 100_001,
      runtimePid: child.pid,
    }));
    await expect(assertDeepSeekRuntimeCreationAllowed()).rejects.toThrow(
      'then manually remove .runtime-state-lock and cleanup-blocked',
    );
    try {
      // A healthy supervisor in another TAKT parent is busy, not failed cleanup.
      await writeFile(ownerPath, JSON.stringify({
        parentPid: process.pid + 100_000,
        supervisorPid: process.pid,
        runtimePid: child.pid,
      }));
      const starts = sdkConstructorOptions.length;
      const busy = await callDeepSeekHarness('worker', 'foreign managed home', { cwd: temporaryRoot });
      expect(busy).toMatchObject({ status: 'error', content: expect.stringContaining('in use by another TAKT process') });
      expect(busy.content).not.toContain('cleanup is unconfirmed');
      expect(sdkConstructorOptions).toHaveLength(starts);
      // Owner publication failure must preserve a concrete live runtime PID.
      await rm(ownerPath);
      await withDeepSeekRuntimeStateFileLock(runtimePaths.state, () =>
        markDeepSeekCleanupBarrierLocked(runtimePaths.state, runtimePaths.owners, child.pid));
      expect(JSON.parse(await readFile(join(runtimePaths.state, 'cleanup-blocked'), 'utf8')))
        .toMatchObject({ runtimePids: [child.pid], unknownRuntime: false });
      await expect(assertDeepSeekRuntimeCreationAllowed()).rejects.toThrow('cleanup is unconfirmed');
      process.kill(-child.pid, 'SIGTERM');
      await waitForExit(child);
      await assertDeepSeekRuntimeCreationAllowed();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      }
    }
  });
});
