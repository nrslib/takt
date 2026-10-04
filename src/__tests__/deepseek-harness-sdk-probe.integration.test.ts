import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { zstdCompressSync } from 'node:zlib';
import { decompressSessionFrames } from './helpers/deepseek-session-frames.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { createSessionDispatchQueue } from '../infra/deepseek-harness/session-dispatch.js';

interface ProbeRunResult {
  sessionId: string;
  finalResponse: string;
  events: unknown[];
  notifications: ProbeNotification[];
}

interface ProbeNotification {
  method: string;
  params: Record<string, unknown>;
}

interface ProbeHarness {
  start(): Promise<void>;
  run(
    input: string,
    options?: {
      sessionId?: string;
      onNotification?: (notification: ProbeNotification) => void;
    },
  ): Promise<ProbeRunResult>;
  close(): Promise<void>;
}

type ProbeHarnessConstructor = new (options: Record<string, unknown>) => ProbeHarness;

interface ProbeNotificationSubscription {
  next(): Promise<ProbeNotification>;
  close(): void;
}

interface ProbeHarnessClient {
  start(): void;
  initialize(params: Record<string, unknown>): Promise<unknown>;
  prompt(sessionId: string, contentBlocks: Array<{ type: 'text'; text: string }>): Promise<string>;
  subscribeSessionTree(sessionId: string): ProbeNotificationSubscription;
  close(): Promise<void>;
}

type ProbeHarnessClientConstructor = new (options: Record<string, unknown>) => ProbeHarnessClient;

interface PackageManifest {
  name: string;
  version: string;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  main?: string;
}

interface MockRequest {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

interface LocalApiMock {
  endpoint: string;
  requests: MockRequest[];
  close(): Promise<void>;
}

const SDK_VERSION = '0.2.0-rc.2';
const STDERR_SENTINEL = 'TAKT_DSH_PROBE_STDERR_SENTINEL';
const isSupportedDshRuntimePlatform = (
  (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64'))
  || (process.platform === 'darwin' && process.arch === 'arm64')
);
const supervisorPath = fileURLToPath(new URL('./fixtures/deepseek-harness-sdk-probe-supervisor.mjs', import.meta.url));
const fakeRuntimePath = fileURLToPath(new URL('./fixtures/deepseek-harness-sdk-probe-runtime.mjs', import.meta.url));

let temporaryRoot: string;
let DeepSeekHarness: ProbeHarnessConstructor;
let HarnessClient: ProbeHarnessClientConstructor;
let sdkManifest: PackageManifest;
let runtimeManifest: PackageManifest;
let runtimeBin: string;
let sdkPackageDirectory: string;
const activeClients: Array<{ close(): Promise<void> }> = [];
const localMocks: LocalApiMock[] = [];
const processGroupFiles: string[] = [];

/** Choose the consumer package root when configured, otherwise resolve packages from the checkout. */
function packageRequireBase(): string {
  const configuredRoot = process.env.TAKT_DSH_SDK_PROBE_PACKAGE_ROOT;
  return configuredRoot === undefined ? process.cwd() : configuredRoot;
}

/** Read a package manifest for SDK/runtime version and distribution assertions. */
function readPackageManifest(packagePath: string): PackageManifest {
  return JSON.parse(readFileSync(packagePath, 'utf8')) as PackageManifest;
}

/** Resolve the SDK from the selected package root and its runtime from the SDK dependency tree. */
function resolveSdkPackage(): { sdkPath: string; runtimePath: string } {
  const requireFromRoot = createRequire(join(packageRequireBase(), 'package.json'));
  const sdkPath = requireFromRoot.resolve('@deepseek-ai/dsh-sdk-client/package.json');
  const requireFromSdk = createRequire(sdkPath);
  const runtimePath = requireFromSdk.resolve('@deepseek-ai/dsh/package.json');
  return { sdkPath, runtimePath };
}

/** Build a dummy-only child environment with isolated home and optional probe modes; never use live credentials. */
function dummyEnvironment(
  launchDirectory: string,
  options: {
    mode?: string;
    dshHome?: string;
    endpoint?: string;
    credential?: string;
    runtimeBin?: string;
    failCleanup?: boolean;
  } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: join(launchDirectory, 'home'),
    TMPDIR: launchDirectory,
    DSH_HOME: options.dshHome ?? join(launchDirectory, 'dsh-home'),
    NO_COLOR: '1',
    LANG: 'C.UTF-8',
    TAKT_DSH_PROBE_MODE: options.mode ?? 'complete',
    TAKT_DSH_PROBE_RUNTIME_PATH: fakeRuntimePath,
    TAKT_DSH_PROBE_RUNTIME_PID_FILE: join(launchDirectory, 'runtime.pid'),
    TAKT_DSH_PROBE_TOOL_PID_FILE: join(launchDirectory, 'tool-child.pid'),
    TAKT_DSH_PROBE_STARTED_FILE: join(launchDirectory, 'started.marker'),
    TAKT_DSH_PROBE_HISTORY_FILE: join(launchDirectory, 'fake-history.jsonl'),
    TAKT_DSH_PROBE_PGID_FILE: join(launchDirectory, 'runtime.pgid'),
    TAKT_DSH_PROBE_SUPERVISOR_PID_FILE: join(launchDirectory, 'supervisor.pid'),
    TAKT_DSH_PROBE_OWNER_RECORD_FILE: join(options.dshHome ?? join(launchDirectory, 'dsh-home'), 'probe-runtime.pgid'),
    TAKT_DSH_PROBE_SPAWN_LOG: join(options.dshHome ?? join(launchDirectory, 'dsh-home'), 'spawned-supervisors.log'),
    TAKT_DSH_PROBE_CLEAN_MARKER: join(launchDirectory, 'cleanup-confirmed.marker'),
  };
  if (options.endpoint !== undefined) env.DEEPSEEK_BASE_URL = options.endpoint;
  if (options.credential !== undefined) env.DEEPSEEK_API_KEY = options.credential;
  if (options.runtimeBin !== undefined) env.TAKT_DSH_PROBE_DSH_BIN = options.runtimeBin;
  if (options.failCleanup === true) env.TAKT_DSH_PROBE_FAIL_CLEANUP = '1';
  return env;
}

/** Create an isolated SDK client with the chosen runtime fixture and register its process group for teardown. */
async function createHarness(
  options: {
    mode?: string;
    dshHome?: string;
    endpoint?: string;
    credential?: string;
    runtimeBin?: string;
    failCleanup?: boolean;
    initializeTimeoutMs?: number;
    requestTimeoutMs?: number;
    shutdownTimeoutMs?: number;
    disposeEofGraceMs?: number;
    disposeGraceMs?: number;
    reasoningEffort?: string;
    model?: string;
    cwd?: string;
    patches?: string[];
  } = {},
): Promise<{ harness: ProbeHarness; launchDirectory: string; env: NodeJS.ProcessEnv }> {
  const launchDirectory = await mkdtemp(join(temporaryRoot, 'launch-'));
  const env = dummyEnvironment(launchDirectory, options);
  const harness = new DeepSeekHarness({
    cwd: options.cwd ?? temporaryRoot,
    dshBin: supervisorPath,
    patches: options.patches ?? [],
    dshHome: options.dshHome ?? env.DSH_HOME,
    env,
    initializeTimeoutMs: options.initializeTimeoutMs ?? 2_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 2_000,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 200,
    disposeEofGraceMs: options.disposeEofGraceMs ?? 120,
    disposeGraceMs: options.disposeGraceMs ?? 120,
    provider: 'deepseek-official',
    model: options.model ?? 'deepseek-v4-flash',
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
  });
  activeClients.push(harness);
  processGroupFiles.push(join(launchDirectory, 'runtime.pgid'));
  return { harness, launchDirectory, env };
}

/** Bound an operation with a labeled timeout and always clear its timer; this does not cancel the operation. */
async function bounded<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Return the rejected value for exposure assertions and fail if the operation unexpectedly succeeds. */
async function rejectionOf<T>(operation: Promise<T>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject');
}

/** Poll for a probe start marker and fail when the publication deadline expires. */
async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await delay(10);
  }
  throw new Error('The probe runtime did not publish its start marker before the deadline');
}

/** Read a fixture PID and reject nonpositive or unsafe integer values before process signaling. */
function readPidFile(filePath: string): number {
  const pid = Number(readFileSync(filePath, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('The probe runtime wrote an invalid process id');
  return pid;
}

/** Test process liveness, excluding observed POSIX zombies and treating uncertain checks as still alive. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
  if (process.platform === 'win32') return true;
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) return true;
  const processState = result.stdout.trim();
  return processState.length > 0 && !processState.startsWith('Z');
}

/** Test owned-group liveness from process listings, falling back conservatively to a signal probe. */
function processGroupIsAlive(pgid: number): boolean {
  if (process.platform !== 'win32') {
    const result = spawnSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8' });
    if (result.error === undefined && result.status === 0) {
      return result.stdout.split('\n').some((line) => {
        const match = line.trim().match(/^(\d+)\s+(\S+)/u);
        return match !== null
          && match[1] !== undefined
          && match[2] !== undefined
          && Number(match[1]) === pgid
          && !match[2].startsWith('Z');
      });
    }
  }
  try {
    process.kill(process.platform === 'win32' ? pgid : -pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
}

/** Poll for process disappearance and return the final liveness result at the deadline. */
async function waitForProcessGone(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await delay(10);
  }
  return !processIsAlive(pid);
}

/** Poll for process-group disappearance and return the final group state at the deadline. */
async function waitForGroupGone(pgid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupIsAlive(pgid)) return true;
    await delay(10);
  }
  return !processGroupIsAlive(pgid);
}

/** Force-stop a fixture process group and fail unless its disappearance is confirmed. */
async function killProcessGroup(pgid: number): Promise<void> {
  try {
    process.kill(process.platform === 'win32' ? pgid : -pgid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  if (!(await waitForGroupGone(pgid))) throw new Error('A probe process group remained after forced cleanup');
}

/** Start a loopback API with selectable tool, reasoning and credential-echo streams; record requests for assertions. */
async function startLocalApiMock(
  mode: 'success' | 'assistant-message-reasoning' | 'assistant-message-text-only' | 'credential-echo' | 'credential-echo-after-success',
): Promise<LocalApiMock> {
  const requests: MockRequest[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      requests.push({
        headers: request.headers,
        body,
      });

      const sequence = requests.length;
      if (mode === 'credential-echo' || (mode === 'credential-echo-after-success' && sequence > 1)) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'authentication_error',
            message: `credential rejected: ${String(request.headers['x-api-key'])}`,
          },
        }));
        return;
      }

      response.writeHead(200, {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream',
      });
      writeSse(response, 'message_start', {
        type: 'message_start',
        message: {
          id: `mock-message-${sequence}`,
          type: 'message',
          role: 'assistant',
          model: 'deepseek-v4-flash',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      });
      if (mode === 'assistant-message-reasoning') {
        writeSse(response, 'content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        });
        writeSse(response, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'mock reasoning analysis' },
        });
        writeSse(response, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        writeSse(response, 'content_block_start', {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        });
        writeSse(response, 'content_block_delta', {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: `mock response ${sequence}` },
        });
        writeSse(response, 'content_block_stop', { type: 'content_block_stop', index: 1 });
      } else {
        writeSse(response, 'content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });
        writeSse(response, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: `mock response ${sequence}` },
        });
        writeSse(response, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      }
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
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Local API mock did not bind a TCP port');
  const mock: LocalApiMock = {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    /** Close all local mock connections before awaiting server shutdown. */
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    },
  };
  localMocks.push(mock);
  return mock;
}

/** Write one SSE event with a JSON payload to the SDK mock response. */
function writeSse(response: ServerResponse, event: string, payload: Record<string, unknown>): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** Expose nested error fields for redaction assertions with bounded recursion, rather than only stringifying messages. */
function serializeErrorExposure(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || value === undefined) return value;
  if (value instanceof Error) {
    const extended = value as Error & { cause?: unknown; data?: unknown; errors?: unknown[] };
    return {
      name: extended.name,
      message: extended.message,
      data: extended.data,
      cause: serializeErrorExposure(extended.cause, depth + 1),
      errors: extended.errors?.map((entry) => serializeErrorExposure(entry, depth + 1)),
    };
  }
  if (Array.isArray(value)) return value.map((entry) => serializeErrorExposure(entry, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, serializeErrorExposure(child, depth + 1)]));
  }
  return value;
}

/** Collect paths and decoded file contents, including Zstd fixtures, for persisted-secret assertions. */
async function readFilesRecursively(directory: string): Promise<{ content: string; paths: string[] }> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { content: '', paths: [] };
    throw error;
  }
  const contents: string[] = [];
  const paths: string[] = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await readFilesRecursively(entryPath);
      contents.push(nested.content);
      paths.push(...nested.paths);
    }
    else if (entry.isFile()) {
      const fileContents = await readFile(entryPath);
      contents.push(entry.name.endsWith('.zstd')
        ? decompressSessionFrames(fileContents).toString('utf8')
        : fileContents.toString('utf8'));
      paths.push(entryPath);
    }
  }
  return { content: contents.join('\n'), paths };
}

/** Accept only non-null, non-array objects when interpreting untrusted probe notifications. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Check that an inbox splice notification acknowledges the requested message ID. */
function isInboxReceiptFor(notification: ProbeNotification, messageId: string): boolean {
  if (notification.method !== 'session.event' || !isRecord(notification.params.event)) return false;
  const event = notification.params.event;
  if (event.type !== 'agent/inbox/spliced' || !isRecord(event.data) || !Array.isArray(event.data.inserted)) {
    return false;
  }
  return event.data.inserted.some((entry) => isRecord(entry) && entry.id === messageId);
}

/** Wait for the matching inbox receipt followed by idle status for the same SDK session, with bounded reads. */
async function waitForPromptIdle(
  subscription: ProbeNotificationSubscription,
  sessionId: string,
  messageId: string,
): Promise<void> {
  let received = false;
  while (true) {
    const notification = await bounded(subscription.next(), 20_000, 'SDK session notification');
    if (isInboxReceiptFor(notification, messageId)) received = true;
    if (
      received
      && notification.method === 'session.status'
      && notification.params.sessionId === sessionId
      && notification.params.status === 'idle'
    ) return;
  }
}

describe('DeepSeek SDK probe persisted-session inspection', () => {
  it('finds a credential in a later Zstd frame through the probe file scanner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'takt-probe-frames-'));
    try {
      const sessionPath = join(root, 'session.zstd');
      await writeFile(sessionPath, Buffer.concat([
        zstdCompressSync(Buffer.from('{"type":"session/header"}\n')),
        zstdCompressSync(Buffer.from('{"message":"dummy-later-frame-secret"}\n')),
      ]));
      const inspection = await readFilesRecursively(root);
      expect(inspection.content).toContain('dummy-later-frame-secret');
      expect(inspection.paths).toEqual([sessionPath]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a malformed later frame instead of reporting a secret-free file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'takt-probe-invalid-frame-'));
    try {
      await writeFile(join(root, 'session.zstd'), Buffer.concat([
        zstdCompressSync(Buffer.from('header')),
        Buffer.from('invalid later frame'),
      ]));
      await expect(readFilesRecursively(root)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('DeepSeek Harness TypeScript SDK feasibility probes', () => {
  beforeAll(async () => {
    const { sdkPath, runtimePath } = resolveSdkPackage();
    sdkManifest = readPackageManifest(sdkPath);
    runtimeManifest = readPackageManifest(runtimePath);
    sdkPackageDirectory = dirname(sdkPath);
    const sdkEntry = join(sdkPackageDirectory, sdkManifest.main ?? 'lib/index.js');
    const sdk = await import(pathToFileURL(sdkEntry).href) as {
      DeepSeekHarness: ProbeHarnessConstructor;
      HarnessClient: ProbeHarnessClientConstructor;
    };
    DeepSeekHarness = sdk.DeepSeekHarness;
    HarnessClient = sdk.HarnessClient;
    const declaredBin = runtimeManifest.bin;
    runtimeBin = join(dirname(runtimePath), typeof declaredBin === 'string' ? declaredBin : declaredBin?.dsh ?? '');
  });

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'takt-dsh-sdk-probe-'));
  });

  afterEach(async () => {
    const closeErrors: unknown[] = [];
    for (const entry of activeClients.splice(0).reverse()) {
      try {
        await bounded(entry.close(), 3_000, 'SDK close during test cleanup');
      } catch (error) {
        closeErrors.push(error);
      }
    }
    for (const mock of localMocks.splice(0).reverse()) await mock.close();
    for (const pidFile of processGroupFiles.splice(0)) {
      if (!existsSync(pidFile)) continue;
      const pgid = readPidFile(pidFile);
      if (processGroupIsAlive(pgid)) await killProcessGroup(pgid);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
    expect(closeErrors).toEqual([]);
  });

  it('uses the exact selected SDK/runtime pair and satisfies the SDK peer package contract', () => {
    expect(sdkManifest.version).toBe(SDK_VERSION);
    expect(runtimeManifest.version).toBe(SDK_VERSION);
    expect(sdkManifest.dependencies?.['@deepseek-ai/dsh']).toBe(SDK_VERSION);
    expect(existsSync(runtimeBin)).toBe(true);

    const requireFromSdk = createRequire(join(sdkPackageDirectory, 'package.json'));
    const peerVersions = Object.keys(sdkManifest.peerDependencies ?? {}).map((name) => {
      const peerPath = requireFromSdk.resolve(`${name}/package.json`);
      return [name, readPackageManifest(peerPath).version] as const;
    });
    expect(peerVersions).toEqual(expect.arrayContaining([
      ['@deepseek-ai/dsh-llm', SDK_VERSION],
      ['@deepseek-ai/dsh-sdk-protocol', SDK_VERSION],
      ['@deepseek-ai/dsh-session', SDK_VERSION],
    ]));
    expect(peerVersions.find(([name]) => name === '@deepseek-ai/cordis')?.[1]).toMatch(/^4\.0\.\d+$/u);
  });

  it.skipIf(!isSupportedDshRuntimePlatform)('continues multiple FIFO turns in one live runtime with an unchanged configuration', async () => {
    const mock = await startLocalApiMock('success');
    const workspace = join(temporaryRoot, 'same-runtime-workspace');
    await mkdir(workspace, { recursive: true });
    const { harness } = await createHarness({
      dshHome: join(temporaryRoot, 'same-runtime-home'),
      endpoint: mock.endpoint,
      credential: 'TAKT_DUMMY_CREDENTIAL_SAME_RUNTIME',
      runtimeBin,
      cwd: workspace,
      reasoningEffort: 'low',
      initializeTimeoutMs: 15_000,
      requestTimeoutMs: 15_000,
      shutdownTimeoutMs: 500,
      disposeEofGraceMs: 300,
      disposeGraceMs: 1_000,
    });

    const dispatchQueue = createSessionDispatchQueue();
    const [firstResult, secondResult] = await bounded(Promise.all([
      dispatchQueue.run('same-runtime-fifo-session', undefined, () => (
        harness.run('first FIFO prompt', { sessionId: 'same-runtime-fifo-session' })
      )),
      dispatchQueue.run('same-runtime-fifo-session', undefined, () => (
        harness.run('second FIFO prompt', { sessionId: 'same-runtime-fifo-session' })
      )),
    ]), 45_000, 'two FIFO turns in one runtime');
    dispatchQueue.clear();
    await bounded(harness.close(), 5_000, 'same-runtime shutdown');

    const firstMessages = mock.requests[0]?.body.messages;
    const secondMessages = mock.requests[1]?.body.messages;
    expect(firstResult).toMatchObject({
      sessionId: 'same-runtime-fifo-session',
      finalResponse: 'mock response 1',
    });
    expect(secondResult).toMatchObject({
      sessionId: 'same-runtime-fifo-session',
      finalResponse: 'mock response 2',
    });
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests.map((request) => request.headers['x-deepseek-harness-session-id']))
      .toEqual(['same-runtime-fifo-session', 'same-runtime-fifo-session']);
    expect(mock.requests.map((request) => (request.body.output_config as Record<string, unknown> | undefined)?.effort))
      .toEqual(['low', 'low']);
    expect(JSON.stringify(firstMessages)).toContain('first FIFO prompt');
    expect(JSON.stringify(firstMessages)).not.toContain('second FIFO prompt');
    expect(JSON.stringify(secondMessages)).toContain('first FIFO prompt');
    expect(JSON.stringify(secondMessages)).toContain('mock response 1');
    expect(JSON.stringify(secondMessages)).toContain('second FIFO prompt');
  }, 60_000);

  it.skipIf(process.platform === 'win32')('discards runtime stderr before it reaches SDK failures', async () => {
    const { harness, launchDirectory } = await createHarness({ mode: 'stderr-exit' });
    const error = await rejectionOf(bounded(harness.start(), 3_000, 'SDK initialization'));
    const pgid = readPidFile(join(launchDirectory, 'runtime.pgid'));

    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify(serializeErrorExposure(error)).includes(STDERR_SENTINEL)).toBe(false);
    expect(await waitForGroupGone(pgid)).toBe(true);
    expect(existsSync(join(launchDirectory, 'cleanup-confirmed.marker'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('cleans the process group after an initialization failure', async () => {
    const { harness, launchDirectory } = await createHarness({ mode: 'initialize-failure' });
    const error = await rejectionOf(bounded(harness.start(), 3_000, 'SDK initialization failure'));
    const pgid = readPidFile(join(launchDirectory, 'runtime.pgid'));

    expect(error).toBeInstanceOf(Error);
    expect(await waitForGroupGone(pgid)).toBe(true);
    expect(existsSync(join(launchDirectory, 'cleanup-confirmed.marker'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('times out initialization and confirms the runtime process group exited', async () => {
    const { harness, launchDirectory } = await createHarness({
      mode: 'initialize-timeout',
      initializeTimeoutMs: 100,
    });
    const error = await rejectionOf(bounded(harness.start(), 2_000, 'bounded initialization'));
    const pgid = readPidFile(join(launchDirectory, 'runtime.pgid'));

    expect(error).toMatchObject({ name: 'RequestTimeoutError' });
    expect(await waitForGroupGone(pgid)).toBe(true);
    expect(existsSync(join(launchDirectory, 'cleanup-confirmed.marker'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('times out a queued turn request and closes the runtime process group', async () => {
    const { harness, launchDirectory } = await createHarness({
      mode: 'turn-timeout',
      requestTimeoutMs: 100,
    });
    const error = await rejectionOf(bounded(
      harness.run('bounded turn', { sessionId: 'request-timeout-session' }),
      2_000,
      'bounded turn request',
    ));
    const pgid = readPidFile(join(launchDirectory, 'runtime.pgid'));
    await bounded(harness.close(), 2_000, 'runtime close after turn timeout');

    expect(error).toMatchObject({ name: 'RequestTimeoutError' });
    expect(await waitForGroupGone(pgid)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('terminates the runtime and its spawned tool child when an active turn is aborted', async () => {
    const { harness, launchDirectory } = await createHarness({ mode: 'hang-after-receipt' });
    const pendingTurn = harness.run('wait for cancellation', { sessionId: 'abort-session' });
    await waitForFile(join(launchDirectory, 'started.marker'));
    await waitForFile(join(launchDirectory, 'tool-child.pid'));
    const runtimePid = readPidFile(join(launchDirectory, 'runtime.pid'));
    const childPid = readPidFile(join(launchDirectory, 'tool-child.pid'));
    const pgid = readPidFile(join(launchDirectory, 'runtime.pgid'));
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => {
      void harness.close();
    }, { once: true });
    controller.abort(new Error('probe turn cancellation'));
    const runError = await rejectionOf(bounded(pendingTurn, 2_000, 'aborted SDK turn'));
    await bounded(harness.close(), 2_000, 'runtime close after cancellation');

    expect(runError).toBeInstanceOf(Error);
    expect(await waitForProcessGone(runtimePid)).toBe(true);
    expect(await waitForProcessGone(childPid)).toBe(true);
    expect(await waitForGroupGone(pgid)).toBe(true);
    expect(existsSync(join(launchDirectory, 'cleanup-confirmed.marker'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('bounds shutdown and confirms the runtime and tool child exited', async () => {
    const { harness, launchDirectory } = await createHarness({
      mode: 'shutdown-hang-child',
      shutdownTimeoutMs: 80,
      disposeEofGraceMs: 300,
      disposeGraceMs: 1_000,
    });
    await bounded(harness.start(), 2_000, 'SDK startup before shutdown timeout');
    const runtimePid = readPidFile(join(launchDirectory, 'runtime.pid'));
    const childPid = readPidFile(join(launchDirectory, 'tool-child.pid'));
    const pgid = readPidFile(join(launchDirectory, 'runtime.pgid'));
    const closeStartedAt = Date.now();
    await bounded(harness.close(), 2_000, 'bounded SDK shutdown');
    const closeDurationMs = Date.now() - closeStartedAt;
    const termination = {
      runtime: await waitForProcessGone(runtimePid),
      child: await waitForProcessGone(childPid),
      group: await waitForGroupGone(pgid),
      cleanupConfirmed: existsSync(join(launchDirectory, 'cleanup-confirmed.marker')),
    };

    expect(closeDurationMs).toBeLessThan(1_500);
    expect(termination).toEqual({ runtime: true, child: true, group: true, cleanupConfirmed: true });
  });

  it.skipIf(process.platform === 'win32')('refuses a restart while a failed cleanup leaves the previous process group alive', async () => {
    const first = await createHarness({
      dshHome: join(temporaryRoot, 'failed-cleanup-home'),
      mode: 'cleanup-failure',
      failCleanup: true,
      initializeTimeoutMs: 100,
      shutdownTimeoutMs: 40,
      disposeEofGraceMs: 30,
      disposeGraceMs: 50,
    });
    const startError = await rejectionOf(bounded(first.harness.start(), 2_000, 'failed initialization cleanup'));
    const pgid = readPidFile(join(first.launchDirectory, 'runtime.pgid'));
    expect(startError).toBeInstanceOf(Error);
    expect(processGroupIsAlive(pgid)).toBe(true);
    expect(existsSync(join(first.launchDirectory, 'cleanup-confirmed.marker'))).toBe(false);

    const next = await createHarness({
      mode: 'complete',
      dshHome: join(temporaryRoot, 'failed-cleanup-home'),
    });
    const startLog = join(first.env.DSH_HOME ?? first.launchDirectory, 'spawned-supervisors.log');
    const startsBeforeRetry = (await readFile(startLog, 'utf8')).trim().split('\n');

    const restartError = await rejectionOf(bounded(next.harness.start(), 2_000, 'restart after unconfirmed cleanup'));
    expect(restartError).toBeInstanceOf(Error);
    expect((restartError as Error).message).not.toContain(STDERR_SENTINEL);
    expect((await readFile(startLog, 'utf8')).trim().split('\n')).toHaveLength(startsBeforeRetry.length);
  });

  it.skipIf(!isSupportedDshRuntimePlatform)('characterizes high-level SDK rejection when restarting a persisted session ID', async () => {
    const mock = await startLocalApiMock('success');
    const dshHome = join(temporaryRoot, 'runtime-home');
    const workspace = join(temporaryRoot, 'workspace');
    await mkdir(workspace, { recursive: true });
    const first = await createHarness({
      dshHome,
      endpoint: mock.endpoint,
      credential: 'TAKT_DUMMY_CREDENTIAL_SESSION_PROBE',
      runtimeBin,
      cwd: workspace,
      reasoningEffort: 'low',
      initializeTimeoutMs: 15_000,
      requestTimeoutMs: 15_000,
      shutdownTimeoutMs: 500,
      disposeEofGraceMs: 300,
      disposeGraceMs: 1_000,
    });
    const firstResult = await bounded(first.harness.run('first persisted prompt', {
      sessionId: 'takt-feasibility-session',
    }), 25_000, 'first official runtime turn');
    await bounded(first.harness.close(), 5_000, 'first official runtime shutdown');
    const savedSessions = await readFilesRecursively(join(dshHome, 'sessions'));
    expect(savedSessions.paths.length).toBeGreaterThan(0);
    expect(mock.requests).toHaveLength(1);

    const second = await createHarness({
      dshHome,
      endpoint: mock.endpoint,
      credential: 'TAKT_DUMMY_CREDENTIAL_SESSION_PROBE',
      runtimeBin,
      cwd: workspace,
      reasoningEffort: 'high',
      initializeTimeoutMs: 15_000,
      requestTimeoutMs: 15_000,
      shutdownTimeoutMs: 500,
      disposeEofGraceMs: 300,
      disposeGraceMs: 1_000,
    });
    let restartError: unknown;
    try {
      await bounded(second.harness.run('second persisted prompt', {
        sessionId: 'takt-feasibility-session',
      }), 25_000, 'second official runtime turn');
    } catch (error) {
      restartError = error;
    }

    expect(firstResult).toMatchObject({ sessionId: 'takt-feasibility-session', finalResponse: 'mock response 1' });
    expect(restartError).toMatchObject({
      name: 'JsonRpcResponseError',
      code: -32603,
      message: 'session "takt-feasibility-session" already exists',
    });
    expect((restartError as { data?: unknown }).data).toBeUndefined();
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.headers['x-deepseek-harness-session-id']).toBe('takt-feasibility-session');
    expect(mock.requests[0]?.body.output_config).toMatchObject({ effort: 'low' });
  }, 65_000);

  it.skipIf(!isSupportedDshRuntimePlatform)('emits SDK assistant/message reasoning content from a local HTTP mock', async () => {
    const mock = await startLocalApiMock('assistant-message-reasoning');
    const harness = await createHarness({
      endpoint: mock.endpoint,
      credential: 'TAKT_DUMMY_CREDENTIAL_ASSISTANT_MESSAGE',
      runtimeBin,
      cwd: temporaryRoot,
      reasoningEffort: 'high',
    });
    const run = await bounded(harness.harness.run('return text and reasoning', {
      onNotification: () => {},
    }), 25_000, 'assistant/message reasoning SDK probe');

    const assistantMessages = run.notifications.flatMap((notification) => {
      if (notification.method !== 'session.event' || !isRecord(notification.params.event)) return [];
      const event = notification.params.event;
      if (event.type !== 'assistant/message' || !isRecord(event.data) || !isRecord(event.data.message)) return [];
      return [event.data.message];
    });
    const content = assistantMessages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
    expect(content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'reasoning', text: 'mock reasoning analysis' }),
      expect.objectContaining({ type: 'text', text: 'mock response 1' }),
    ]));
    expect(run.finalResponse).toBe('mock response 1');
    await bounded(harness.harness.close(), 5_000, 'assistant/message probe shutdown');
  }, 45_000);

  it.skipIf(!isSupportedDshRuntimePlatform)('emits SDK assistant/message text content without a reasoning block', async () => {
    const mock = await startLocalApiMock('assistant-message-text-only');
    const harness = await createHarness({
      endpoint: mock.endpoint,
      credential: 'TAKT_DUMMY_CREDENTIAL_ASSISTANT_TEXT',
      runtimeBin,
      cwd: temporaryRoot,
    });
    const run = await bounded(harness.harness.run('return only text', {
      onNotification: () => {},
    }), 25_000, 'assistant/message text SDK probe');

    const assistantMessages = run.notifications.flatMap((notification) => {
      if (notification.method !== 'session.event' || !isRecord(notification.params.event)) return [];
      const event = notification.params.event;
      if (event.type !== 'assistant/message' || !isRecord(event.data) || !isRecord(event.data.message)) return [];
      return [event.data.message];
    });
    const content = assistantMessages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
    expect(content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'mock response 1' }),
    ]));
    expect(content.some((block) => isRecord(block) && block.type === 'reasoning')).toBe(false);
    await bounded(harness.harness.close(), 5_000, 'assistant/message text probe shutdown');
  }, 45_000);

  it.skipIf(!isSupportedDshRuntimePlatform)('characterizes low-level public client rejection for a persisted session ID', async () => {
    const mock = await startLocalApiMock('success');
    const dshHome = join(temporaryRoot, 'low-level-restart-home');
    const workspace = join(temporaryRoot, 'low-level-restart-workspace');
    await mkdir(workspace, { recursive: true });
    const sessionId = 'low-level-persisted-session';

    /** Create a restart-test client sharing the test home while isolating launch markers and registering cleanup. */
    async function createClient(): Promise<{
      client: ProbeHarnessClient;
      launchDirectory: string;
    }> {
      const launchDirectory = await mkdtemp(join(temporaryRoot, 'low-level-restart-'));
      const env = dummyEnvironment(launchDirectory, {
        dshHome,
        endpoint: mock.endpoint,
        credential: 'TAKT_DUMMY_CREDENTIAL_LOW_LEVEL_RESTART',
        runtimeBin,
      });
      const client = new HarnessClient({
        processCwd: workspace,
        dshBin: supervisorPath,
        dshHome,
        env,
        initializeTimeoutMs: 15_000,
        requestTimeoutMs: 15_000,
        shutdownTimeoutMs: 500,
        disposeEofGraceMs: 300,
        disposeGraceMs: 1_000,
      });
      activeClients.push(client);
      processGroupFiles.push(join(launchDirectory, 'runtime.pgid'));
      return { client, launchDirectory };
    }

    const first = await createClient();
    const firstSubscription = first.client.subscribeSessionTree(sessionId);
    first.client.start();
    const route = { cwd: workspace, provider: 'deepseek-official', model: 'deepseek-v4-flash' };
    await bounded(first.client.initialize({ ...route, reasoningEffort: 'low' }), 20_000, 'first low-level handshake');
    const firstMessageId = await bounded(
      first.client.prompt(sessionId, [{ type: 'text', text: 'first persisted low-level prompt' }]),
      20_000,
      'first low-level prompt',
    );
    await waitForPromptIdle(firstSubscription, sessionId, firstMessageId);
    firstSubscription.close();
    await bounded(first.client.close(), 5_000, 'first low-level runtime shutdown');
    const savedSessions = await readFilesRecursively(join(dshHome, 'sessions'));
    expect(savedSessions.paths.length).toBeGreaterThan(0);
    expect(mock.requests).toHaveLength(1);

    const second = await createClient();
    const secondSubscription = second.client.subscribeSessionTree(sessionId);
    let reconnectError: unknown;
    try {
      second.client.start();
      await bounded(second.client.initialize({ ...route, reasoningEffort: 'high' }), 20_000, 'second low-level handshake');
      const secondMessageId = await bounded(
        second.client.prompt(sessionId, [{ type: 'text', text: 'second persisted low-level prompt' }]),
        20_000,
        'second low-level prompt for the existing session',
      );
      await waitForPromptIdle(secondSubscription, sessionId, secondMessageId);
    } catch (error) {
      reconnectError = error;
    }
    secondSubscription.close();

    expect(reconnectError).toMatchObject({
      name: 'JsonRpcResponseError',
      code: -32603,
      message: `session "${sessionId}" already exists`,
    });
    expect((reconnectError as { data?: unknown }).data).toBeUndefined();
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.body.output_config).toMatchObject({ effort: 'low' });
  }, 65_000);

  it.skipIf(!isSupportedDshRuntimePlatform)('characterizes same-runtime effort reinitialization retaining the original setting', async () => {
    const mock = await startLocalApiMock('success');
    const launchDirectory = await mkdtemp(join(temporaryRoot, 'live-client-'));
    const workspace = join(temporaryRoot, 'live-client-workspace');
    const dshHome = join(temporaryRoot, 'live-client-home');
    await mkdir(workspace, { recursive: true });
    const env = dummyEnvironment(launchDirectory, {
      dshHome,
      endpoint: mock.endpoint,
      credential: 'TAKT_DUMMY_CREDENTIAL_LIVE_CLIENT_PROBE',
      runtimeBin,
    });
    const client = new HarnessClient({
      processCwd: workspace,
      dshBin: supervisorPath,
      dshHome: env.DSH_HOME,
      env,
      initializeTimeoutMs: 15_000,
      requestTimeoutMs: 15_000,
      shutdownTimeoutMs: 500,
      disposeEofGraceMs: 300,
      disposeGraceMs: 1_000,
    });
    const sessionId = 'live-client-effort-change-session';
    const subscription = client.subscribeSessionTree(sessionId);
    processGroupFiles.push(join(launchDirectory, 'runtime.pgid'));

    try {
      client.start();
      const baseRoute = { cwd: workspace, provider: 'deepseek-official', model: 'deepseek-v4-flash' };
      await bounded(client.initialize({ ...baseRoute, reasoningEffort: 'low' }), 20_000, 'initial public client handshake');
      const firstMessageId = await bounded(
        client.prompt(sessionId, [{ type: 'text', text: 'first live-client prompt' }]),
        20_000,
        'first public client prompt',
      );
      await waitForPromptIdle(subscription, sessionId, firstMessageId);

      await bounded(client.initialize({ ...baseRoute, reasoningEffort: 'high' }), 20_000, 'changed public client handshake');
      const secondMessageId = await bounded(
        client.prompt(sessionId, [{ type: 'text', text: 'second live-client prompt' }]),
        20_000,
        'second public client prompt',
      );
      await waitForPromptIdle(subscription, sessionId, secondMessageId);

      expect(mock.requests).toHaveLength(2);
      expect(mock.requests.map((request) => (request.body.output_config as Record<string, unknown> | undefined)?.effort))
        .toEqual(['low', 'low']);
      expect(JSON.stringify(mock.requests[1]?.body.messages)).toContain('first live-client prompt');
      expect(JSON.stringify(mock.requests[1]?.body.messages)).toContain('second live-client prompt');
    } finally {
      subscription.close();
      await bounded(client.close(), 5_000, 'public client shutdown after effort probe');
    }

    const freshSession = await createHarness({
      dshHome,
      endpoint: mock.endpoint,
      credential: 'TAKT_DUMMY_CREDENTIAL_LIVE_CLIENT_PROBE',
      runtimeBin,
      cwd: workspace,
      reasoningEffort: 'high',
      initializeTimeoutMs: 15_000,
      requestTimeoutMs: 15_000,
      shutdownTimeoutMs: 500,
      disposeEofGraceMs: 300,
      disposeGraceMs: 1_000,
    });
    const freshResult = await bounded(freshSession.harness.run('explicit new session prompt', {
      sessionId: 'explicit-new-effort-session',
    }), 25_000, 'new session using changed reasoning effort');
    await bounded(freshSession.harness.close(), 5_000, 'new-session runtime shutdown');

    expect(freshResult).toMatchObject({
      sessionId: 'explicit-new-effort-session',
      finalResponse: 'mock response 3',
    });
    expect(mock.requests).toHaveLength(3);
    expect(mock.requests[2]?.body.output_config).toMatchObject({ effort: 'high' });
    expect(JSON.stringify(mock.requests[2]?.body.messages)).toContain('explicit new session prompt');
    expect(JSON.stringify(mock.requests[2]?.body.messages)).not.toContain('first live-client prompt');
    expect(JSON.stringify(mock.requests[2]?.body.messages)).not.toContain('second live-client prompt');
  }, 65_000);

  it.skipIf(process.platform === 'win32')('characterizes a dummy credential echo in raw SDK notifications and later persisted session frames', async () => {
    const mock = await startLocalApiMock('credential-echo-after-success');
    const dshHome = join(temporaryRoot, 'runtime-home');
    const credential = 'TAKT_DUMMY_CREDENTIAL_ECHO_SENTINEL';
    const { harness } = await createHarness({
      dshHome,
      endpoint: mock.endpoint,
      credential,
      runtimeBin,
      initializeTimeoutMs: 15_000,
      requestTimeoutMs: 15_000,
      shutdownTimeoutMs: 500,
      disposeEofGraceMs: 300,
      disposeGraceMs: 1_000,
    });
    const notifications: ProbeNotification[] = [];
    let result: ProbeRunResult | undefined;
    let runError: unknown;
    try {
      await bounded(harness.run('create a persisted session before the local mock error', {
        sessionId: 'credential-echo-session',
        onNotification: (notification) => notifications.push(notification),
      }), 25_000, 'initial successful session turn');
      result = await bounded(harness.run('cause a local mock authentication error', {
        sessionId: 'credential-echo-session',
        onNotification: (notification) => notifications.push(notification),
      }), 25_000, 'local mock authentication response');
    } catch (error) {
      runError = error;
    }
    await bounded(harness.close(), 5_000, 'runtime shutdown after mock error');
    const savedSessions = await readFilesRecursively(join(dshHome, 'sessions'));

    expect(mock.requests).toHaveLength(2);
    expect(mock.requests.every((request) => request.headers['x-api-key'] === credential)).toBe(true);
    expect(savedSessions.paths.length).toBeGreaterThan(0);
    expect({
      notification: (JSON.stringify(notifications) ?? '').includes(credential),
      result: (JSON.stringify(result ?? null) ?? '').includes(credential),
      error: (JSON.stringify(serializeErrorExposure(runError)) ?? '').includes(credential),
      savedSession: savedSessions.content.includes(credential),
    // This is the unpatched upstream SDK, not TAKT's protected runtime. The
    // credential-store integration suite verifies TAKT disables persistence.
    }).toEqual({ notification: true, result: true, error: false, savedSession: true });
  }, 45_000);

  it.skipIf(!isSupportedDshRuntimePlatform)('sends the exact per-run system prompt through a public profile patch', async () => {
    const mock = await startLocalApiMock('success');
    const workspace = join(temporaryRoot, 'system-prompt-workspace');
    await mkdir(workspace, { recursive: true });
    const systemPrompt = 'Follow this literal instruction: {{unknown_template}}.\nKeep {{ and }} unchanged.';
    const profilePatch = join(temporaryRoot, 'system-prompt.patch.yml');
    const pluginPath = fileURLToPath(new URL('../infra/deepseek-harness/system-prompt-plugin.mjs', import.meta.url));
    await writeFile(profilePatch, stringifyYaml([{
      insert: [{
        id: 'takt-system-prompt',
        name: pathToFileURL(pluginPath).href,
        inject: ['systemPrompt'],
        config: { prompt: systemPrompt },
      }],
    }]), 'utf8');
    const { harness } = await createHarness({
      dshHome: join(temporaryRoot, 'system-prompt-runtime-home'),
      endpoint: mock.endpoint,
      credential: 'TAKT_DUMMY_CREDENTIAL_SYSTEM_PROMPT',
      runtimeBin,
      cwd: workspace,
      patches: [profilePatch],
      initializeTimeoutMs: 15_000,
      requestTimeoutMs: 15_000,
      shutdownTimeoutMs: 500,
      disposeEofGraceMs: 300,
      disposeGraceMs: 1_000,
    });

    const result = await bounded(harness.run('user instruction', { sessionId: 'system-prompt-session' }), 25_000, 'system-prompt SDK turn');
    await bounded(harness.close(), 5_000, 'system-prompt runtime shutdown');

    expect(result.finalResponse).toBe('mock response 1');
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.body.system).toBe(systemPrompt);
  }, 45_000);
});
