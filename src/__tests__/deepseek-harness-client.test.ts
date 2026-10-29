import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekHarness, HarnessClient, RequestTimeoutError, TransportClosedError, type DeepSeekHarnessOptions } from '@deepseek-ai/dsh-sdk-client';
import { parse as parseYaml } from 'yaml';
import { createPartTimeoutReason } from '../shared/types/agent-failure.js';

interface ManagedModuleLoadEvidence {
  directory: string;
  sdkPath: string;
  llmPath: string;
  piAiPackagePath?: string;
  piAiVersion?: string;
}

const managedPackageRootEnvironmentKey = vi.hoisted(() => 'TAKT_DSH_CLIENT_PACKAGE_ROOT');
const sdkConstructorOptions = vi.hoisted(() => [] as Array<DeepSeekHarnessOptions | undefined>);
const managedModuleLoads = vi.hoisted(() => vi.fn<(evidence: ManagedModuleLoadEvidence) => void>());
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
vi.mock('../infra/deepseek-harness/managed-package.js', async (importOriginal) => {
  const managed = await importOriginal<typeof import('../infra/deepseek-harness/managed-package.js')>();
  return {
    ...managed,
    loadManagedDeepSeekHarnessModules: async () => {
      const packageRoot = process.env[managedPackageRootEnvironmentKey]
        ?? fileURLToPath(new URL('../..', import.meta.url));
      const requireFromPackageRoot = createRequire(join(packageRoot, 'package.json'));
      const sdkPath = requireFromPackageRoot.resolve('@deepseek-ai/dsh-sdk-client');
      const llmPath = requireFromPackageRoot.resolve('@deepseek-ai/dsh-llm');
      let evidence: ManagedModuleLoadEvidence = { directory: packageRoot, sdkPath, llmPath };
      const selectedPackageRoot = process.env[managedPackageRootEnvironmentKey];
      const [sdk, llm] = selectedPackageRoot
        ? await Promise.all([
          import(pathToFileURL(sdkPath).href),
          import(pathToFileURL(llmPath).href),
        ])
        : await Promise.all([
          import('@deepseek-ai/dsh-sdk-client'),
          import('@deepseek-ai/dsh-llm'),
        ]);
      if (selectedPackageRoot) {
        const piAiPackagePath = await realpath(join(
          packageRoot,
          'node_modules',
          '@earendil-works',
          'pi-ai',
          'package.json',
        ));
        const piAiManifest = JSON.parse(await readFile(piAiPackagePath, 'utf8')) as { version: string };
        evidence = { ...evidence, piAiPackagePath, piAiVersion: piAiManifest.version };
      }
      managedModuleLoads(evidence);
      return {
        directory: packageRoot,
        sdk,
        llm,
      };
    },
  };
});
import {
  callDeepSeekHarness,
  closeDeepSeekHarnessProcesses,
} from '../infra/deepseek-harness/index.js';
import { DeepSeekHarnessProvider } from '../infra/providers/deepseek-harness.js';
import { DeepSeekHarnessInstallRequiredError, installDeepSeekHarness } from '../infra/deepseek-harness/managed-package.js';
import { resolveDeepSeekHarnessNpmPlugins } from '../infra/deepseek-harness/npm-plugin.js';
import * as runtimeState from '../infra/deepseek-harness/runtime-state.js';
import {
  acknowledgeDeepSeekRuntimeCleanup,
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

interface LocalNpmPackage {
  name: string;
  version: string;
  filename: string;
  tarballPath: string;
}

interface LocalNpmRegistry {
  endpoint: string;
  requests: string[];
  close(): Promise<void>;
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
const offlineManagedNpmCache = process.env.TAKT_DSH_OFFLINE_NPM_CACHE;
const environmentKeys = ['TAKT_CONFIG_DIR', 'DSH_HOME', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'PI_CODING_AGENT_DIR', 'NPM_CONFIG_CACHE', 'npm_config_cache', 'NPM_CONFIG_OFFLINE', 'npm_config_offline', 'npm_config_ignore_scripts', managedPackageRootEnvironmentKey] as const;
const savedEnvironment = new Map<string, string | undefined>();
let temporaryRoot: string;
let localApis: LocalApi[] = [];
let localNpmRegistries: LocalNpmRegistry[] = [];

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

/** Pack a local fixture without lifecycle scripts for the network-free npm registry. */
async function packLocalNpmPackage(packageDirectory: string, destinationDirectory: string): Promise<LocalNpmPackage> {
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  const output = execFileSync('npm', [
    'pack', '--json', '--ignore-scripts', '--pack-destination', destinationDirectory,
  ], { cwd: packageDirectory, encoding: 'utf8' });
  const packed = JSON.parse(output) as Array<{ filename?: unknown }>;
  const filename = packed[0]?.filename;
  if (typeof filename !== 'string') throw new Error('npm pack fixture did not return a tarball filename');
  return {
    name: manifest.name,
    version: manifest.version,
    filename,
    tarballPath: join(destinationDirectory, filename),
  };
}

/** Serve fixture metadata and tarballs over loopback and register the server for teardown. */
async function startLocalNpmRegistry(packages: readonly LocalNpmPackage[]): Promise<LocalNpmRegistry> {
  const requests: string[] = [];
  const packageByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  let endpoint: string;
  const server = createServer((request, response) => {
    void (async () => {
      const requestedPath = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(1));
      requests.push(requestedPath);
      const tarball = packages.find((pkg) => pkg.filename === requestedPath);
      if (tarball !== undefined) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(await readFile(tarball.tarballPath));
        return;
      }
      const pkg = packageByName.get(requestedPath);
      if (pkg === undefined) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        name: pkg.name,
        'dist-tags': { latest: pkg.version },
        versions: {
          [pkg.version]: {
            name: pkg.name,
            version: pkg.version,
            dist: { tarball: `${endpoint}/${encodeURIComponent(pkg.filename)}` },
          },
        },
      }));
    })().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(error instanceof Error ? error.message : 'Local npm registry failure');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Local npm registry did not bind');
  endpoint = `http://127.0.0.1:${address.port}`;
  const registry: LocalNpmRegistry = {
    endpoint,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
  localNpmRegistries.push(registry);
  return registry;
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

/** Find a nonexistent process-group ID for deterministic stale-owner cleanup fixtures. */
function unusedProcessGroupPid(): number {
  let pid = process.pid + 100_000;
  while (true) {
    try {
      process.kill(-pid, 0);
      pid += 100_000;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      return pid;
    }
  }
}

/** Run an isolated parent with supplied environment, capture stdout, and bound its process-group lifetime. */
async function runSeparateParentProcess(
  script: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs = 60_000,
  keepStdinOpen = false,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: environment,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!keepStdinOpen) child.stdin.end();
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const timeout = setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined) {
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
      const forceKill = setTimeout(() => {
        try { process.kill(process.platform === 'win32' ? child.pid! : -child.pid!, 'SIGKILL'); } catch { /* Already exited. */ }
      }, 1_000);
      forceKill.unref?.();
    }
  }, timeoutMs);
  timeout.unref?.();
  return new Promise((resolve, reject) => {
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code, stdout, stderr, timedOut });
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

/** Wait for asynchronously owned runtime resources to be removed after exit confirmation. */
async function waitForPathRemoval(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for resource removal: ${path}`);
}

describe('DeepSeek Harness TypeScript SDK client', () => {
  beforeEach(async () => {
    sdkConstructorOptions.length = 0;
    managedModuleLoads.mockClear();
    for (const key of environmentKeys) savedEnvironment.set(key, process.env[key]);
    temporaryRoot = await mkdtemp(join(tmpdir(), 'takt-deepseek-client-sdk-'));
    process.env.npm_config_cache = join(temporaryRoot, 'npm-cache');
    process.env.TAKT_CONFIG_DIR = join(temporaryRoot, 'takt');
    process.env.PI_CODING_AGENT_DIR = join(temporaryRoot, 'pi-agent');
    process.env.DSH_HOME = join(temporaryRoot, 'credential-source');
    process.env.DEEPSEEK_API_KEY = DUMMY_CREDENTIAL;
    delete process.env.DEEPSEEK_BASE_URL;
    delete process.env[managedPackageRootEnvironmentKey];
    await mkdir(process.env.DSH_HOME, { recursive: true });
    await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  });

  afterEach(async () => {
    await closeDeepSeekHarnessProcesses().catch(() => undefined);
    vi.restoreAllMocks();
    for (const api of localApis.splice(0)) await api.close();
    for (const registry of localNpmRegistries.splice(0)) await registry.close();
    await rm(temporaryRoot, { recursive: true, force: true });
    for (const key of environmentKeys) {
      const value = savedEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnvironment.clear();
  });

  it.skipIf(!SUPPORTED_RUNTIME)('reports missing or damaged SDK before resolving any configured Git plugin', async () => {
    managedModuleLoads.mockImplementationOnce(() => { throw new DeepSeekHarnessInstallRequiredError(); });
    const cloneDirectoriesBefore = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith('takt-deepseek-plugin-'));
    const response = await callDeepSeekHarness('worker', 'Must not fetch a plugin.', {
      cwd: temporaryRoot,
      providerOptions: { plugins: [{ id: 'unreachable', source: 'unsupported-plugin-source' }] },
    });
    expect(response.status).toBe('error');
    expect(response.content).toContain('takt install deepseek-harness');
    expect(response.content).not.toContain('plugin source');
    expect(managedModuleLoads).toHaveBeenCalledOnce();
    expect(sdkConstructorOptions).toHaveLength(0);
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-plugin-')))
      .toEqual(cloneDirectoriesBefore);
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
      initializeTimeoutMs: 30_000,
      requestTimeoutMs: 5_000,
      shutdownTimeoutMs: 2_000,
      disposeEofGraceMs: 15_000,
      disposeGraceMs: 15_000,
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

  it.skipIf(!SUPPORTED_RUNTIME)('uses the root SDK modules for one live session and refuses after teardown', async () => {
    const api = await startLocalApi();
    process.env.DEEPSEEK_BASE_URL = api.endpoint;
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
    process.env[managedPackageRootEnvironmentKey] = packageRoot;
    const runtimePaths = getDeepSeekRuntimePaths();
    const workspace = join(temporaryRoot, 'workspace');
    await mkdir(workspace, { recursive: true });
    const initial = await callDeepSeekHarness('worker', 'initial prompt without an ID', {
      cwd: workspace,
      providerOptions: { reasoningEffort: 'low', baseUrl: api.endpoint },
    });
    expect(managedModuleLoads).toHaveBeenCalledTimes(1);
    const requireFromPackageRoot = createRequire(join(packageRoot, 'package.json'));
    expect(managedModuleLoads).toHaveBeenCalledWith({
      directory: packageRoot,
      sdkPath: requireFromPackageRoot.resolve('@deepseek-ai/dsh-sdk-client'),
      llmPath: requireFromPackageRoot.resolve('@deepseek-ai/dsh-llm'),
      piAiPackagePath: await realpath(join(
        packageRoot,
        'node_modules',
        '@earendil-works',
        'pi-ai',
        'package.json',
      )),
      piAiVersion: '1.4.0',
    });
    expect(api.requests).toHaveLength(1);
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
    expect(managedModuleLoads).toHaveBeenCalledTimes(1);
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
    expect(managedModuleLoads).toHaveBeenCalledTimes(1);
    expect(api.requests).toHaveLength(3);
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME)('does not start the next same-session request before timeout cleanup completes', async () => {
    const api = await startLocalApi();
    const workspace = join(temporaryRoot, 'timeout-cleanup-workspace');
    await mkdir(workspace, { recursive: true });
    const options = {
      cwd: workspace,
      providerOptions: { baseUrl: api.endpoint, shutdownTimeoutMs: 2_000 },
    };
    const initial = await callDeepSeekHarness('worker', 'start before timing out', options);
    expect(initial).toMatchObject({ status: 'done', sessionId: expect.any(String) });
    const sessionId = initial.sessionId!;
    api.setMode('hold-response');
    const timeoutController = new AbortController();
    const timeoutMs = 1_000;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let cleanupHasStarted = false;
    const originalClose = DeepSeekHarness.prototype.close;
    const close = vi.spyOn(DeepSeekHarness.prototype, 'close').mockImplementation(async function (this: DeepSeekHarness) {
      cleanupHasStarted = true;
      await cleanupGate;
      await originalClose.call(this);
    });

    try {
      const timedOutTurn = callDeepSeekHarness('worker', 'time out while the API response is held', {
        ...options,
        sessionId,
        abortSignal: timeoutController.signal,
      });
      await vi.waitFor(() => expect(api.requests).toHaveLength(2), { timeout: 10_000, interval: 25 });
      const nextTurn = callDeepSeekHarness('worker', 'must wait for timeout cleanup', { ...options, sessionId });
      timeoutHandle = setTimeout(() => {
        timeoutController.abort(new Error(createPartTimeoutReason(timeoutMs)));
      }, timeoutMs);

      await vi.waitFor(() => expect(cleanupHasStarted).toBe(true), { timeout: 10_000, interval: 25 });
      const requestsWhileCleanupIsPending = api.requests.map((request) => JSON.stringify(request.body.messages)).join('\n');
      expect(requestsWhileCleanupIsPending).not.toContain('must wait for timeout cleanup');

      releaseCleanup();
      const [timedOut, next] = await Promise.all([timedOutTurn, nextTurn]);
      expect(timedOut).toMatchObject({ status: 'error', failureCategory: 'part_timeout' });
      expect(next).toMatchObject({ status: 'error', failureCategory: 'session_continuation_unsupported' });
      expect(api.requests).toHaveLength(2);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      releaseCleanup();
      close.mockRestore();
    }
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME)('does not start the next same-session request before abort cleanup completes', async () => {
    const api = await startLocalApi();
    const workspace = join(temporaryRoot, 'abort-cleanup-workspace');
    await mkdir(workspace, { recursive: true });
    const options = {
      cwd: workspace,
      providerOptions: { baseUrl: api.endpoint, requestTimeoutMs: 30_000, shutdownTimeoutMs: 2_000 },
    };
    const initial = await callDeepSeekHarness('worker', 'start before aborting', options);
    expect(initial).toMatchObject({ status: 'done', sessionId: expect.any(String) });
    const sessionId = initial.sessionId!;
    api.setMode('hold-response');
    const abortController = new AbortController();

    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let cleanupHasStarted = false;
    const originalClose = DeepSeekHarness.prototype.close;
    const close = vi.spyOn(DeepSeekHarness.prototype, 'close').mockImplementation(async function (this: DeepSeekHarness) {
      cleanupHasStarted = true;
      await cleanupGate;
      await originalClose.call(this);
    });

    try {
      const abortedTurn = callDeepSeekHarness('worker', 'abort while the API response is held', {
        ...options,
        sessionId,
        abortSignal: abortController.signal,
      });
      await vi.waitFor(() => expect(api.requests).toHaveLength(2), { timeout: 10_000, interval: 25 });
      const nextTurn = callDeepSeekHarness('worker', 'must wait for abort cleanup', { ...options, sessionId });
      abortController.abort(new Error('test aborted active DeepSeek turn'));

      await vi.waitFor(() => expect(cleanupHasStarted).toBe(true), { timeout: 10_000, interval: 25 });
      const requestsWhileCleanupIsPending = api.requests.map((request) => JSON.stringify(request.body.messages)).join('\n');
      expect(requestsWhileCleanupIsPending).not.toContain('must wait for abort cleanup');

      releaseCleanup();
      const [aborted, next] = await Promise.all([abortedTurn, nextTurn]);
      expect(aborted.failureCategory).toBe('external_abort');
      expect(next).toMatchObject({ status: 'error', failureCategory: 'session_continuation_unsupported' });
      expect(api.requests).toHaveLength(2);
    } finally {
      releaseCleanup();
      close.mockRestore();
    }
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME)('uses the credential selected by each request context', async () => {
    const api = await startLocalApi();
    const workspace = join(temporaryRoot, 'credential-context-workspace');
    const contexts = [
      {
        home: join(temporaryRoot, 'first-credential-context'),
        reference: 'FIRST_DSH_CREDENTIAL',
        credential: 'TAKT_DUMMY_FIRST_CONTEXT_CREDENTIAL',
      },
      {
        home: join(temporaryRoot, 'second-credential-context'),
        reference: 'SECOND_DSH_CREDENTIAL',
        credential: 'TAKT_DUMMY_SECOND_CONTEXT_CREDENTIAL',
      },
    ];
    await mkdir(workspace, { recursive: true });

    for (const [index, context] of contexts.entries()) {
      await mkdir(context.home, { recursive: true });
      await writeFile(
        join(context.home, 'settings.yaml'),
        `llm-deepseek:\n  apiKeyEnv: ${context.reference}\n`,
      );
      const credentialStore = join(context.home, '.credentials.yaml');
      await writeFile(
        credentialStore,
        `version: 1\nrefs:\n  ${context.reference}: ${context.credential}\n`,
      );
      await chmod(credentialStore, 0o600);

      const response = await callDeepSeekHarness('worker', `request from credential context ${index + 1}`, {
        cwd: workspace,
        childProcessEnv: { DSH_HOME: context.home },
        providerOptions: { baseUrl: api.endpoint },
      });

      expect(response.status).toBe('done');
      expect(api.requests[index]?.headers['x-api-key']).toBe(context.credential);
      await closeDeepSeekHarnessProcesses();
    }

    expect(api.requests).toHaveLength(contexts.length);
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME)('loads Git plugins in the official runtime and separates sessions by plugin source', async () => {
    const api = await startLocalApi();
    const workspace = join(temporaryRoot, 'git-plugin-workspace');
    await mkdir(workspace, { recursive: true });
    const pluginDirectoriesBefore = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith('takt-deepseek-plugin-'));

    const createGitPlugin = async (directoryName: string, text: string): Promise<string> => {
      const repository = join(temporaryRoot, directoryName);
      await mkdir(repository, { recursive: true });
      execFileSync('git', ['init', '-b', 'main'], { cwd: repository });
      execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repository });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repository });
      await writeFile(join(repository, 'package.json'), JSON.stringify({
        name: directoryName,
        type: 'module',
        main: 'index.js',
        dependencies: { 'git-plugin-test-helper': 'file:packages/plugin-helper' },
      }));
      await mkdir(join(repository, 'packages', 'plugin-helper'), { recursive: true });
      await writeFile(join(repository, 'packages', 'plugin-helper', 'package.json'), JSON.stringify({
        name: 'git-plugin-test-helper',
        version: '1.0.0',
        type: 'module',
        main: 'index.js',
      }));
      await writeFile(join(repository, 'packages', 'plugin-helper', 'index.js'), [
        'export function decorate(text) {',
        "  return `dependency:${text}`;",
        '}',
      ].join('\n'));
      await writeFile(join(repository, 'index.js'), [
        "import { decorate } from 'git-plugin-test-helper';",
        "import { writeFileSync } from 'node:fs';",
        'export default function apply(_ctx, config) {',
        '  writeFileSync(config.marker, decorate(config.text));',
        '}',
      ].join('\n'));
      execFileSync('git', ['add', '.'], { cwd: repository });
      execFileSync('git', ['commit', '-m', 'plugin'], { cwd: repository });
      const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
      return `git:${pathToFileURL(repository).href}#${ref}`;
    };

    const firstText = 'git-plugin-first-marker';
    const secondText = 'git-plugin-second-marker';
    const firstMarker = join(temporaryRoot, 'first-plugin-loaded');
    const secondMarker = join(temporaryRoot, 'second-plugin-loaded');
    const firstSource = await createGitPlugin('first-git-plugin', firstText);
    const secondSource = await createGitPlugin('second-git-plugin', secondText);
    const runWithPlugin = (
      source: string,
      sessionId?: string,
      overrides: { omitRef?: boolean; ref?: string; config?: Record<string, unknown> } = {},
    ) => {
      const sourceRef = source.split('#')[1]!;
      const ref = overrides.ref === undefined ? sourceRef : overrides.ref;
      const config = {
        marker: source === firstSource ? firstMarker : secondMarker,
        text: source === firstSource ? firstText : secondText,
        ...overrides.config,
      };
      return callDeepSeekHarness('worker', 'Return ok.', {
        cwd: workspace,
        sessionId,
        providerOptions: {
          baseUrl: api.endpoint,
          plugins: [{
            id: 'git-test-plugin',
            source: source.split('#')[0]!,
            ...(overrides.omitRef ? {} : { ref }),
            config,
          },
          ],
        },
      });
    };

    const first = await runWithPlugin(firstSource);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const second = await runWithPlugin(secondSource, undefined, { omitRef: true });
    expect(warning.mock.calls.flat().join('\n')).toContain('no ref');
    warning.mockRestore();
    expect(first).toMatchObject({ status: 'done', sessionId: expect.any(String) });
    expect(second).toMatchObject({ status: 'done', sessionId: expect.any(String) });
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(await readFile(firstMarker, 'utf8')).toBe(`dependency:${firstText}`);
    expect(await readFile(secondMarker, 'utf8')).toBe(`dependency:${secondText}`);

    const continued = await runWithPlugin(firstSource, first.sessionId);
    expect(continued).toMatchObject({ status: 'done', sessionId: first.sessionId });

    const changed = await runWithPlugin(secondSource, first.sessionId);
    expect(changed).toMatchObject({ status: 'error', failureCategory: 'session_continuation_unsupported' });
    const changedRef = await runWithPlugin(firstSource, first.sessionId, { ref: 'main' });
    expect(changedRef).toMatchObject({ status: 'error', failureCategory: 'session_continuation_unsupported' });
    const changedConfig = await runWithPlugin(firstSource, first.sessionId, { config: { text: `${firstText}-changed` } });
    expect(changedConfig).toMatchObject({ status: 'error', failureCategory: 'session_continuation_unsupported' });
    expect(api.requests).toHaveLength(3);

    await closeDeepSeekHarnessProcesses();
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-plugin-')))
      .toEqual(pluginDirectoriesBefore);
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME)('merges Git and npm plugins in configured order and disposes both resolver installations', async () => {
    const api = await startLocalApi();
    const workspace = join(temporaryRoot, 'mixed-plugin-workspace');
    const npmPackageDirectory = join(temporaryRoot, 'mixed-npm-plugin');
    const gitRepository = join(temporaryRoot, 'mixed-git-plugin');
    const orderPath = join(temporaryRoot, 'mixed-plugin-order');
    const npmEvidencePath = join(temporaryRoot, 'mixed-npm-plugin-evidence.json');
    await mkdir(workspace, { recursive: true });
    await mkdir(npmPackageDirectory, { recursive: true });
    await mkdir(gitRepository, { recursive: true });
    await writeFile(join(npmPackageDirectory, 'package.json'), JSON.stringify({
      name: 'local-mixed-npm-plugin',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    await writeFile(join(npmPackageDirectory, 'index.js'), [
      "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
      "import { fileURLToPath } from 'node:url';",
      'export default function apply(_ctx, config) {',
      "  const patchIndex = process.argv.indexOf('--patch');",
      '  const patchPath = patchIndex < 0 ? undefined : process.argv[patchIndex + 1];',
      '  writeFileSync(config.evidencePath, JSON.stringify({',
      '    entry: fileURLToPath(import.meta.url),',
      '    patch: patchPath === undefined ? "" : readFileSync(patchPath, "utf8"),',
      '  }));',
      "  appendFileSync(config.orderPath, 'npm,');",
      '}',
    ].join('\n'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: gitRepository });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: gitRepository });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitRepository });
    await writeFile(join(gitRepository, 'package.json'), JSON.stringify({
      name: 'local-mixed-git-plugin',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    await writeFile(join(gitRepository, 'index.js'), [
      "import { appendFileSync } from 'node:fs';",
      'export default function apply(_ctx, config) {',
      "  appendFileSync(config.orderPath, 'git');",
      '}',
    ].join('\n'));
    execFileSync('git', ['add', '.'], { cwd: gitRepository });
    execFileSync('git', ['commit', '-m', 'mixed plugin fixture'], { cwd: gitRepository });
    const gitRef = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: gitRepository,
      encoding: 'utf8',
    }).trim();
    const gitDirectoriesBefore = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith('takt-deepseek-plugin-'));
    const npmDirectoriesBefore = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));

    try {
      const response = await callDeepSeekHarness('worker', 'Load both configured plugins.', {
        cwd: workspace,
        providerOptions: {
          baseUrl: api.endpoint,
          plugins: [
            {
              id: 'npm-first-plugin',
              source: `npm:file:${npmPackageDirectory}`,
              config: { evidencePath: npmEvidencePath, orderPath },
            },
            {
              id: 'git-second-plugin',
              source: `git:${pathToFileURL(gitRepository).href}`,
              ref: gitRef,
              config: { orderPath },
            },
          ],
        },
      });

      expect(response.status).toBe('done');
      expect(await readFile(orderPath, 'utf8')).toBe('npm,git');
      const npmEvidence = JSON.parse(await readFile(npmEvidencePath, 'utf8')) as {
        entry: string;
        patch: string;
      };
      expect(path.isAbsolute(npmEvidence.entry)).toBe(true);
      const runtimePatch = parseYaml(npmEvidence.patch) as Array<Record<string, unknown>>;
      const insertedPlugins = runtimePatch.flatMap((entry) =>
        Array.isArray(entry.insert) ? entry.insert as Array<Record<string, unknown>> : []);
      expect(insertedPlugins.map((plugin) => plugin.id)).toEqual([
        'npm-first-plugin',
        'git-second-plugin',
      ]);

      const npmEntrypoints = JSON.parse(String(
        sdkConstructorOptions[0]?.env?.TAKT_DSH_NPM_PLUGIN_ENTRYPOINTS,
      )) as string[];
      expect(npmEntrypoints).toEqual([pathToFileURL(npmEvidence.entry).href]);
      expect(npmEntrypoints).not.toContain(insertedPlugins[1]?.name);

      const createdGitDirectories = (await readdir(tmpdir()))
        .filter((entry) => entry.startsWith('takt-deepseek-plugin-') && !gitDirectoriesBefore.includes(entry));
      const createdNpmDirectories = (await readdir(tmpdir()))
        .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-') && !npmDirectoriesBefore.includes(entry));
      expect(createdGitDirectories).toHaveLength(1);
      expect(createdNpmDirectories).toHaveLength(1);
      const cleanupPaths = JSON.parse(String(sdkConstructorOptions[0]?.env?.TAKT_DSH_CLEANUP_PATHS)) as string[];
      expect(cleanupPaths).toContain(join(tmpdir(), createdGitDirectories[0]!));
      expect(cleanupPaths).toContain(join(tmpdir(), createdNpmDirectories[0]!));

      await closeDeepSeekHarnessProcesses();
      expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-plugin-'))
        .sort()).toEqual([...gitDirectoriesBefore].sort());
      expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'))
        .sort()).toEqual([...npmDirectoriesBefore].sort());
    } finally {
      await closeDeepSeekHarnessProcesses();
    }
  }, 90_000);

  it('resolves a local npm package entrypoint and removes its temporary installation on disposal', async () => {
    const packageDirectory = join(temporaryRoot, 'npm-resolver-package');
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'local-npm-resolver-plugin',
      version: '1.0.0',
      type: 'module',
      exports: { '.': { import: './cordis.mjs', default: './fallback.js' } },
    }));
    await writeFile(join(packageDirectory, 'cordis.mjs'), 'export default function apply() {}');
    const pluginDirectoriesBefore = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));

    const resolution = await resolveDeepSeekHarnessNpmPlugins([`npm:file:${packageDirectory}`]);
    const entrypoint = fileURLToPath(resolution.plugins[0]!.name);
    expect(resolution.plugins).toEqual([{ name: pathToFileURL(entrypoint).href }]);
    expect(path.isAbsolute(entrypoint)).toBe(true);
    expect(existsSync(entrypoint)).toBe(true);
    await resolution.dispose();
    await resolution.dispose();
    expect(existsSync(entrypoint)).toBe(false);
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-')))
      .toEqual(pluginDirectoriesBefore);
  }, 30_000);

  it.each([
    ['dist/index', 'dist/index.js'],
    ['dist', 'dist/index.js'],
    ['dist/', 'dist/index.js'],
    ['missing.js', 'index.js'],
  ])('resolves the legacy main %s with Node package fallbacks', async (main, entry) => {
    const packageDirectory = join(temporaryRoot, 'npm-legacy-main-package');
    await mkdir(dirname(join(packageDirectory, entry)), { recursive: true });
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'local-legacy-main-plugin', version: '1.0.0', type: 'module', main,
    }));
    await writeFile(join(packageDirectory, entry), 'export default function apply() {}');
    const resolution = await resolveDeepSeekHarnessNpmPlugins([`npm:file:${packageDirectory}`]);
    try {
      expect(fileURLToPath(resolution.plugins[0]!.name)).toBe(
        join(resolution.cleanupPaths[0]!, 'install/node_modules/local-legacy-main-plugin', entry),
      );
    } finally {
      await resolution.dispose();
    }
  }, 30_000);

  it.each(['main', 'exports'] as const)('resolves a %s entry through an aliased temporary directory and cleans it up', async (entryField) => {
    const realTemporaryDirectory = join(temporaryRoot, 'real-tmp');
    const aliasedTemporaryDirectory = join(temporaryRoot, 'tmp-alias');
    const packageDirectory = join(temporaryRoot, 'npm-aliased-path-package');
    await mkdir(realTemporaryDirectory);
    await symlink(realTemporaryDirectory, aliasedTemporaryDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    await mkdir(packageDirectory);
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'local-aliased-path-plugin', version: '1.0.0', [entryField]: './index.js',
    }));
    await writeFile(join(packageDirectory, 'index.js'), 'module.exports = {};');
    const temporaryEnvironmentKeys = ['TMPDIR', 'TEMP', 'TMP'] as const;
    const previous = temporaryEnvironmentKeys.map((key) => [key, process.env[key]] as const);
    for (const key of temporaryEnvironmentKeys) process.env[key] = aliasedTemporaryDirectory;
    let resolution: Awaited<ReturnType<typeof resolveDeepSeekHarnessNpmPlugins>> | undefined;
    try {
      expect(await realpath(tmpdir())).not.toBe(tmpdir());
      resolution = await resolveDeepSeekHarnessNpmPlugins([`npm:file:${packageDirectory}`]);
      const installDirectory = resolution.cleanupPaths[0]!;
      const canonicalDirectory = await realpath(installDirectory);
      const entrypoint = fileURLToPath(resolution.plugins[0]!.name);
      expect(entrypoint).toBe(join(canonicalDirectory, 'install/node_modules/local-aliased-path-plugin/index.js'));
      expect(existsSync(entrypoint)).toBe(true);
      await resolution.dispose();
      expect(existsSync(installDirectory)).toBe(false);
      expect(existsSync(canonicalDirectory)).toBe(false);
    } finally {
      await resolution?.dispose();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 30_000);

  it('does not apply legacy extension probing to exports targets', async () => {
    const packageDirectory = join(temporaryRoot, 'npm-exact-exports-package');
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'local-exact-exports-plugin', version: '1.0.0', exports: './index',
    }));
    await writeFile(join(packageDirectory, 'index.js'), 'module.exports = {};');
    await expect(resolveDeepSeekHarnessNpmPlugins([`npm:file:${packageDirectory}`]))
      .rejects.toMatchObject({ stage: 'entrypoint' });
  }, 30_000);

  it.each([
    { name: 'a missing export file', exports: './missing.js' },
    { name: 'a require-only root', exports: { '.': { require: './index.js' } } },
    { name: 'only subpath exports', exports: { './private': './index.js' } },
    { name: 'an extensionless export target', exports: './index' },
    { name: 'a null import before default', exports: { import: null, default: './index.js' } },
    { name: 'a null node before import', exports: { node: null, import: './index.js' } },
    { name: 'a null default before import', exports: { default: null, import: './index.js' } },
    { name: 'a nested null import', exports: { node: { import: null, default: './index.js' }, default: './index.js' } },
    { name: 'a null import in an explicit root', exports: { '.': { import: null, default: './index.js' } } },
    { name: 'a null root', exports: { '.': null } },
    { name: 'an import array containing only null', exports: { import: [null], default: './index.js' } },
    { name: 'an empty import array', exports: { import: [], default: './index.js' } },
  ])('rejects $name without falling back to a valid main', async ({ exports: exportsField }) => {
    const packageDirectory = join(temporaryRoot, 'npm-exports-no-fallback-package');
    await mkdir(packageDirectory);
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'local-exports-no-fallback-plugin', version: '1.0.0',
      exports: exportsField, main: './index.js',
    }));
    await writeFile(join(packageDirectory, 'index.js'), 'module.exports = {};');
    const before = (await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));
    let resolution: Awaited<ReturnType<typeof resolveDeepSeekHarnessNpmPlugins>> | undefined;
    try {
      await expect(resolveDeepSeekHarnessNpmPlugins([`npm:file:${packageDirectory}`]).then((value) => {
        resolution = value;
        return value;
      })).rejects.toMatchObject({ name: 'DeepSeekHarnessNpmPluginResolutionError', stage: 'entrypoint' });
    } finally {
      await resolution?.dispose();
    }
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'))).toEqual(before);
  }, 30_000);

  it.each([
    { name: 'the exported root', exports: './public.js' },
    { name: 'default after an unmatched null condition', exports: { require: null, default: './public.js' } },
    { name: 'default after unmatched nested conditions', exports: { import: { browser: null }, default: './public.js' } },
    { name: 'an array fallback after null', exports: { import: [null, './public.js'], default: './private.js' } },
    { name: 'default after an array of unmatched conditions', exports: { import: [{ browser: null }], default: './public.js' } },
  ])('uses $name rather than a different main entrypoint', async ({ exports: exportsField }) => {
    const packageDirectory = join(temporaryRoot, 'npm-exports-precedence-package');
    await mkdir(packageDirectory);
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'local-exports-precedence-plugin', version: '1.0.0',
      exports: exportsField, main: './private.js',
    }));
    await writeFile(join(packageDirectory, 'public.js'), 'module.exports = {};');
    await writeFile(join(packageDirectory, 'private.js'), 'module.exports = {};');
    const resolution = await resolveDeepSeekHarnessNpmPlugins([`npm:file:${packageDirectory}`]);
    try {
      expect(path.basename(fileURLToPath(resolution.plugins[0]!.name))).toBe('public.js');
    } finally {
      await resolution.dispose();
    }
  }, 30_000);

  it.skipIf(process.platform === 'win32')('accepts npm pack metadata larger than one MiB and cleans its installation', async () => {
    const fakeNpmDirectory = join(temporaryRoot, 'large-pack-npm-bin');
    await mkdir(fakeNpmDirectory);
    const fakeNpm = join(fakeNpmDirectory, 'npm');
    await writeFile(fakeNpm, [
      '#!/usr/bin/env node',
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const args = process.argv.slice(2);',
      "const name = 'local-large-pack-plugin';",
      "if (args[0] === 'pack') {",
      "  const filename = `${name}-1.0.0.tgz`;",
      "  writeFileSync(join(args[args.indexOf('--pack-destination') + 1], filename), '');",
      "  process.stdout.write(JSON.stringify([{ filename, name, files: [{ path: 'x'.repeat(2 * 1024 * 1024) }] }]));",
      '} else {',
      "  const directory = join(args[args.indexOf('--prefix') + 1], 'node_modules', name);",
      '  mkdirSync(directory, { recursive: true });',
      "  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, main: './index.js' }));",
      "  writeFileSync(join(directory, 'index.js'), 'module.exports = {};');",
      '}',
    ].join('\n'));
    await chmod(fakeNpm, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeNpmDirectory}${path.delimiter}${previousPath ?? ''}`;
    try {
      const resolution = await resolveDeepSeekHarnessNpmPlugins(['npm:local-large-pack-plugin@1.0.0']);
      const entrypoint = fileURLToPath(resolution.plugins[0]!.name);
      expect(existsSync(entrypoint)).toBe(true);
      await resolution.dispose();
      expect(existsSync(entrypoint)).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  }, 15_000);

  it('rejects credential-bearing npm URLs before allocating resources or starting npm', async () => {
    const before = (await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));
    const controller = new AbortController();
    controller.abort();
    for (const spec of [
      'https://user:secret@example.com/plugin.tgz',
      'https://secret@example.com/plugin.tgz',
      'https://example.com/plugin.tgz?token=secret',
      'https://example.com/plugin.tgz?%74oken=secret',
      'https://example.com/plugin.tgz?X-Amz-Security-Token=secret',
      'https://example.com/plugin.tgz?api_key=secret',
      'https://example.com/plugin.tgz?auth=secret',
      'https://example.com/plugin.tgz?Signature=secret',
      'https://example.com/plugin.tgz?Key-Pair-Id=private-key-id',
      'https://example.com/plugin.tgz?Expires=2000000000',
      'https://example.com/plugin.tgz?Signature=secret&Key-Pair-Id=private-key-id&Expires=2000000000',
      'https://example.com/plugin.tgz?%53ignature=secret',
      'https://example.com/plugin.tgz?Policy=private-policy',
      'https://example.com/plugin.tgz?X-Amz-Signature=secret',
      'https://example.com/plugin.tgz?X-Goog-Signature=secret',
      'https://example.com/plugin.tgz?sig=secret',
      'alias@https://example.com/plugin.tgz?password=secret',
      'alias@https://example.com/plugin.tgz?Signature=secret',
    ]) {
      for (const option of [`npm:${spec}`, { source: `npm:${spec}` }]) {
        await expect(resolveDeepSeekHarnessNpmPlugins([option], controller.signal))
          .rejects.toMatchObject({ stage: 'source', message: 'DeepSeek Harness npm plugin source failed' });
      }
    }
    // A safe URL reaches the abort guard, proving URL sources themselves remain supported.
    await expect(resolveDeepSeekHarnessNpmPlugins(['npm:https://example.com/plugin.tgz?version=1'], controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'))).toEqual(before);
  });

  it('classifies npm source, install, and entrypoint failures and cleans failed installations', async () => {
    await expect(resolveDeepSeekHarnessNpmPlugins(['npm:']))
      .rejects.toMatchObject({ name: 'DeepSeekHarnessNpmPluginResolutionError', stage: 'source' });
    const sourceFailureDirectoriesBefore = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));
    await expect(resolveDeepSeekHarnessNpmPlugins([`npm:file:${join(temporaryRoot, 'missing-npm-source')}`]))
      .rejects.toMatchObject({ name: 'DeepSeekHarnessNpmPluginResolutionError', stage: 'source' });
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-')))
      .toEqual(sourceFailureDirectoriesBefore);

    const invalidPackageDirectory = join(temporaryRoot, 'npm-invalid-install-package');
    await mkdir(invalidPackageDirectory, { recursive: true });
    await writeFile(join(invalidPackageDirectory, 'package.json'), JSON.stringify({
      name: 'local-install-failure-package',
      version: '1.0.0',
      main: './index.js',
      dependencies: { 'invalid dependency name': '1.0.0' },
    }));
    await writeFile(join(invalidPackageDirectory, 'index.js'), 'module.exports = {};');
    const pluginDirectoriesBefore = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));
    await expect(resolveDeepSeekHarnessNpmPlugins([`npm:file:${invalidPackageDirectory}`]))
      .rejects.toMatchObject({ name: 'DeepSeekHarnessNpmPluginResolutionError', stage: 'install' });

    const noEntrypointDirectory = join(temporaryRoot, 'npm-no-entrypoint-package');
    await mkdir(noEntrypointDirectory, { recursive: true });
    await writeFile(join(noEntrypointDirectory, 'package.json'), JSON.stringify({
      name: 'local-npm-no-entrypoint',
      version: '1.0.0',
    }));
    await expect(resolveDeepSeekHarnessNpmPlugins([`npm:file:${noEntrypointDirectory}`]))
      .rejects.toMatchObject({ name: 'DeepSeekHarnessNpmPluginResolutionError', stage: 'entrypoint' });
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-')))
      .toEqual(pluginDirectoriesBefore);
  }, 30_000);

  it.skipIf(process.platform === 'win32')('aborts npm installation and removes the in-progress temporary directory', async () => {
    const packageDirectory = join(temporaryRoot, 'npm-abort-package');
    const fakeNpmDirectory = join(temporaryRoot, 'fake-npm-bin');
    const installStartedPath = join(temporaryRoot, 'fake-npm-install-started');
    await mkdir(packageDirectory, { recursive: true });
    await mkdir(fakeNpmDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'local-npm-abort-plugin',
      version: '1.0.0',
    }));
    const fakeNpm = join(fakeNpmDirectory, 'npm');
    await writeFile(fakeNpm, [
      '#!/usr/bin/env node',
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const args = process.argv.slice(2);',
      "if (args[0] === 'pack') {",
      "  const destination = args[args.indexOf('--pack-destination') + 1];",
      "  const filename = 'local-npm-abort-plugin-1.0.0.tgz';",
      '  writeFileSync(join(destination, filename), \'\');',
      "  process.stdout.write(JSON.stringify([{ filename, name: 'local-npm-abort-plugin' }]));",
      "} else if (args[0] === 'install') {",
      `  writeFileSync(${JSON.stringify(installStartedPath)}, 'install');`,
      '  setTimeout(() => {}, 60_000);',
      '} else {',
      '  process.exitCode = 1;',
      '}',
    ].join('\n'));
    await chmod(fakeNpm, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeNpmDirectory}${path.delimiter}${previousPath ?? ''}`;
    const pluginDirectoriesBefore = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));
    const abortController = new AbortController();
    try {
      const resolution = resolveDeepSeekHarnessNpmPlugins(
        [`npm:file:${packageDirectory}`],
        abortController.signal,
      );
      await waitForFile(installStartedPath, 5_000);
      expect(await readFile(installStartedPath, 'utf8')).toBe('install');
      abortController.abort();
      await expect(resolution).rejects.toMatchObject({ name: 'AbortError' });
      expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-')))
        .toEqual(pluginDirectoriesBefore);
    } finally {
      abortController.abort();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  }, 15_000);

  it.skipIf(!SUPPORTED_RUNTIME)('does not infer Cordis failure from an untyped runtime exit during npm plugin startup and cleans its installed package', async () => {
    const api = await startLocalApi();
    const settingsPath = join(process.env.DSH_HOME!, 'settings.yaml');
    await writeFile(settingsPath, '# user-owned DeepSeek settings must remain unchanged\n');
    const packageDirectory = join(temporaryRoot, 'npm-startup-failure-package');
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'local-npm-startup-failure-plugin',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    await writeFile(join(packageDirectory, 'index.js'), [
      'export default function apply() {',
      '  process.exit(1);',
      '}',
    ].join('\n'));
    const pluginDirectoriesBefore = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));

    const response = await callDeepSeekHarness('worker', 'must fail during Cordis plugin startup', {
      cwd: temporaryRoot,
      providerOptions: { baseUrl: api.endpoint, plugins: [`npm:file:${packageDirectory}`] },
    });
    expect(response).toMatchObject({
      status: 'error',
      failureCategory: 'provider_error',
      content: 'DeepSeek Harness runtime connection closed. Verify the runtime installation and retry. Upstream error details are withheld.',
    });
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-')))
      .toEqual(pluginDirectoriesBefore);
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME)('reports the official Cordis diagnostic for a failed npm plugin and cleans its installation', async () => {
    const api = await startLocalApi();
    const packageDirectory = join(temporaryRoot, 'npm-cordis-load-failure-package');
    const pluginDirectoriesBefore = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'local-npm-cordis-load-failure-plugin',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    await writeFile(join(packageDirectory, 'index.js'), [
      'export default function apply() {',
      "  const error = new Error('cordis fixture load failure');",
      "  error.stack = 'error: cordis fixture load failure';",
      '  throw error;',
      '}',
    ].join('\n'));

    const response = await callDeepSeekHarness('worker', 'must report the failed Cordis plugin', {
      cwd: temporaryRoot,
      providerOptions: {
        baseUrl: api.endpoint,
        plugins: [{ id: 'npm-cordis-load-failure', source: `npm:file:${packageDirectory}` }],
      },
    });

    expect(response).toMatchObject({
      status: 'error',
      failureCategory: 'provider_error',
      content: 'DeepSeek Harness npm plugin failed to load. Check the package entrypoint and configuration, then retry. Upstream error details are withheld.',
    });
    expect(response.content).not.toContain('cordis fixture load failure');
    expect(api.requests).toHaveLength(0);
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-')))
      .toEqual(pluginDirectoriesBefore);
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME)('reports a failed npm plugin when it replaces process.emit', async () => {
    const api = await startLocalApi();
    const packageDirectory = join(temporaryRoot, 'npm-process-emit-interceptor-package');
    const pluginDirectoriesBefore = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'local-npm-process-emit-interceptor-plugin',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    await writeFile(join(packageDirectory, 'index.js'), [
      'export default function apply() {',
      '  const originalEmit = process.emit;',
      '  process.emit = function (eventName, ...args) {',
      "    if (eventName === 'takt:dsh:runtime-boot-diagnostic') return true;",
      '    return Reflect.apply(originalEmit, this, [eventName, ...args]);',
      '  };',
      "  const error = new Error('process emit interceptor fixture failure');",
      "  error.stack = 'error: process emit interceptor fixture failure';",
      '  throw error;',
      '}',
    ].join('\n'));

    const response = await callDeepSeekHarness('worker', 'must report the failed plugin despite a replaced process.emit', {
      cwd: temporaryRoot,
      providerOptions: {
        baseUrl: api.endpoint,
        plugins: [{ id: 'npm-process-emit-interceptor', source: `npm:file:${packageDirectory}` }],
      },
    });

    expect(response).toMatchObject({
      status: 'error',
      failureCategory: 'provider_error',
      content: 'DeepSeek Harness npm plugin failed to load. Check the package entrypoint and configuration, then retry. Upstream error details are withheld.',
    });
    expect(response.content).not.toContain('process emit interceptor fixture failure');
    expect(api.requests).toHaveLength(0);
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-')))
      .toEqual(pluginDirectoriesBefore);
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME)('does not trust a plugin call to the exported startup audit as a DSH load failure', async () => {
    const api = await startLocalApi();
    const packageDirectory = join(temporaryRoot, 'npm-startup-audit-spoof-package');
    const pluginDirectoriesBefore = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'local-npm-startup-audit-spoof-plugin',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    await writeFile(join(packageDirectory, 'index.js'), [
      "import { writeFileSync } from 'node:fs';",
      "import { pathToFileURL } from 'node:url';",
      'export default async function apply() {',
      `  writeFileSync(${JSON.stringify(join(packageDirectory, 'invoked.txt'))}, 'invoked');`,
      '  const { auditStartupEntries } = await import(pathToFileURL(process.env.TAKT_DSH_RUNTIME_BOOT_MODULE).href);',
      '  const context = {',
      '    loader: {',
      '      entries: () => [{ options: { id: \'sdk-jsonrpc-server\', name: import.meta.url } }],',
      '    },',
      '  };',
      "  await auditStartupEntries(context, 'forged', () => {}, true).catch(() => {});",
      '  process.exit(1);',
      '}',
    ].join('\n'));

    const response = await callDeepSeekHarness('worker', 'must reject a plugin-forged startup audit failure', {
      cwd: temporaryRoot,
      providerOptions: {
        baseUrl: api.endpoint,
        plugins: [{ id: 'npm-startup-audit-spoof', source: `npm:file:${packageDirectory}` }],
      },
    });

    expect(await readFile(join(packageDirectory, 'invoked.txt'), 'utf8')).toBe('invoked');
    expect(response).toMatchObject({
      status: 'error',
      failureCategory: 'provider_error',
      content: 'DeepSeek Harness runtime connection closed. Verify the runtime installation and retry. Upstream error details are withheld.',
    });
    expect(response.content).not.toContain('forged');
    expect(api.requests).toHaveLength(0);
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-')))
      .toEqual(pluginDirectoriesBefore);
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME)('reports the DSH startup diagnostic for a failed required npm plugin and cleans its installation', async () => {
    const api = await startLocalApi();
    const packageDirectory = join(temporaryRoot, 'npm-required-cordis-load-failure-package');
    const pluginDirectoriesBefore = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'local-npm-required-cordis-load-failure-plugin',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    await writeFile(join(packageDirectory, 'index.js'), [
      'export default function apply() {',
      "  const error = new Error('required cordis fixture load failure');",
      "  error.stack = 'error: required cordis fixture load failure';",
      '  throw error;',
      '}',
    ].join('\n'));

    const response = await callDeepSeekHarness('worker', 'must report the failed required Cordis plugin', {
      cwd: temporaryRoot,
      providerOptions: {
        baseUrl: api.endpoint,
        plugins: [{ id: 'sdk-jsonrpc-server', source: `npm:file:${packageDirectory}` }],
      },
    });

    expect(response).toMatchObject({
      status: 'error',
      failureCategory: 'provider_error',
      content: 'DeepSeek Harness npm plugin failed to load. Check the package entrypoint and configuration, then retry. Upstream error details are withheld.',
    });
    expect(response.content).not.toContain('required cordis fixture load failure');
    expect(api.requests).toHaveLength(0);
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-')))
      .toEqual(pluginDirectoriesBefore);
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME)('does not classify plugin-owned Cordis diagnostic text as an official load failure', async () => {
    const api = await startLocalApi();
    const packageDirectory = join(temporaryRoot, 'npm-spoofed-cordis-diagnostic-package');
    const pluginDirectoriesBefore = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'local-npm-spoofed-cordis-diagnostic-plugin',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    await writeFile(join(packageDirectory, 'index.js'), [
      'export default function apply() {',
      "  process.stderr.write(`dsh: warning: 1 entry did not activate\\nnpm-cordis-load-failure (${import.meta.url}): error: cordis fixture load failure\\n`, () => process.exit(1));",
      '}',
    ].join('\n'));

    const response = await callDeepSeekHarness('worker', 'must keep plugin-owned diagnostics generic', {
      cwd: temporaryRoot,
      providerOptions: {
        baseUrl: api.endpoint,
        plugins: [{ id: 'npm-cordis-load-failure', source: `npm:file:${packageDirectory}` }],
      },
    });

    expect(response).toMatchObject({
      status: 'error',
      failureCategory: 'provider_error',
      content: 'DeepSeek Harness runtime connection closed. Verify the runtime installation and retry. Upstream error details are withheld.',
    });
    expect(api.requests).toHaveLength(0);
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-')))
      .toEqual(pluginDirectoriesBefore);
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME).each([
    {
      kind: 'optional warning',
      functionName: 'auditStartupEntries',
      filenameExpression: 'pathToFileURL(process.env.TAKT_DSH_RUNTIME_BOOT_MODULE).href',
      diagnostic: (entrypoint: string) =>
        `dsh: warning: 1 entry did not activate\nnpm-vm-stack-spoof (${entrypoint}): error: forged optional failure\n`,
    },
    {
      kind: 'required failure',
      functionName: 'reportStartupFailure',
      filenameExpression: 'pathToFileURL(process.argv[1]).href',
      diagnostic: (entrypoint: string) =>
        `dsh: startup failed: 1 required plugin did not activate\n\nFailed plugins (1):\n  sdk-jsonrpc-server (required)\n    Package: ${entrypoint}\n    Error: forged required failure\n`,
    },
  ])('does not classify a plugin-owned VM stack spoof for a DSH $kind as an official load failure', async ({
    functionName,
    filenameExpression,
    diagnostic,
  }) => {
    const api = await startLocalApi();
    const packageDirectory = join(temporaryRoot, 'npm-vm-stack-spoof-package');
    const pluginDirectoriesBefore = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'local-npm-vm-stack-spoof-plugin',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    await writeFile(join(packageDirectory, 'index.js'), [
      "import { runInThisContext } from 'node:vm';",
      "import { pathToFileURL } from 'node:url';",
      'export default function apply() {',
      `  const functionName = ${JSON.stringify(functionName)};`,
      `  const filename = ${filenameExpression};`,
      `  const diagnostic = ${JSON.stringify(diagnostic('PLACEHOLDER'))}.replace('PLACEHOLDER', import.meta.url);`,
      "  const source = 'function ' + functionName + '() { process.stderr.write(' + JSON.stringify(diagnostic) + ', () => process.exit(1)); } ' + functionName + '();';",
      '  runInThisContext(source, { filename });',
      '}',
    ].join('\n'));

    const response = await callDeepSeekHarness('worker', 'must reject a VM-forged DSH diagnostic', {
      cwd: temporaryRoot,
      providerOptions: {
        baseUrl: api.endpoint,
        plugins: [{ id: 'vm-stack-spoof', source: `npm:file:${packageDirectory}` }],
      },
    });

    expect(response).toMatchObject({
      status: 'error',
      failureCategory: 'provider_error',
      content: 'DeepSeek Harness runtime connection closed. Verify the runtime installation and retry. Upstream error details are withheld.',
    });
    expect(response.content).not.toContain('forged');
    expect(api.requests).toHaveLength(0);
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-')))
      .toEqual(pluginDirectoriesBefore);
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME).each([
    { label: 'without a token', token: undefined },
    { label: 'with a mismatched token', token: '0'.repeat(64) },
  ])('does not classify a plugin-owned fd 3 event $label', async ({ token }) => {
    const api = await startLocalApi();
    const packageDirectory = join(temporaryRoot, 'npm-forged-fd3-diagnostic-package');
    const pluginDirectoriesBefore = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'local-npm-forged-fd3-diagnostic-plugin',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    const tokenField = token === undefined ? '' : `, token: ${JSON.stringify(token)}`;
    await writeFile(join(packageDirectory, 'index.js'), [
      "import { writeSync } from 'node:fs';",
      'export default function apply() {',
      `  writeSync(3, JSON.stringify({ entrypoint: import.meta.url${tokenField} }) + '\\n');`,
      '  process.exit(1);',
      '}',
    ].join('\n'));

    const response = await callDeepSeekHarness('worker', 'must reject a forged fd 3 diagnostic', {
      cwd: temporaryRoot,
      providerOptions: {
        baseUrl: api.endpoint,
        plugins: [{ id: 'forged-fd3-diagnostic', source: `npm:file:${packageDirectory}` }],
      },
    });

    expect(response).toMatchObject({
      status: 'error',
      failureCategory: 'provider_error',
      content: 'DeepSeek Harness runtime connection closed. Verify the runtime installation and retry. Upstream error details are withheld.',
    });
    expect(response.content).not.toContain('forged fd 3 diagnostic');
    expect(api.requests).toHaveLength(0);
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-')))
      .toEqual(pluginDirectoriesBefore);
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME)('keeps an untyped transport close generic with or without an installed npm plugin', async () => {
    vi.spyOn(DeepSeekHarness.prototype, 'start')
      .mockRejectedValue(new TransportClosedError('unrelated runtime transport close'));
    vi.spyOn(DeepSeekHarness.prototype, 'close').mockResolvedValue(undefined);
    const packageDirectory = join(temporaryRoot, 'npm-transport-close-package');
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'local-npm-transport-close-plugin',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    await writeFile(join(packageDirectory, 'index.js'), 'export default function apply() {}');
    const pluginDirectoriesBefore = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));
    const expectedDiagnostic = 'DeepSeek Harness runtime connection closed. Verify the runtime installation and retry. Upstream error details are withheld.';

    const withoutPlugin = await callDeepSeekHarness('worker', 'transport close without npm plugin', {
      cwd: temporaryRoot,
    });
    const withPlugin = await callDeepSeekHarness('worker', 'transport close with npm plugin', {
      cwd: temporaryRoot,
      providerOptions: { plugins: [`npm:file:${packageDirectory}`] },
    });

    expect(withoutPlugin).toMatchObject({
      status: 'error',
      failureCategory: 'provider_error',
      content: expectedDiagnostic,
    });
    expect(withPlugin).toMatchObject({
      status: 'error',
      failureCategory: 'provider_error',
      content: expectedDiagnostic,
    });
    expect(withPlugin.content).toBe(withoutPlugin.content);
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-')))
      .toEqual(pluginDirectoriesBefore);
  }, 30_000);

  it.skipIf(!SUPPORTED_RUNTIME)('loads a raw string npm plugin source in the official runtime', async () => {
    const api = await startLocalApi();
    const workspace = join(temporaryRoot, 'npm-string-plugin-workspace');
    const packageDirectory = join(temporaryRoot, 'npm-string-plugin-package');
    const marker = join(temporaryRoot, 'npm-string-plugin-loaded');
    await mkdir(workspace, { recursive: true });
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'local-npm-string-plugin',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    await writeFile(join(packageDirectory, 'index.js'), [
      "import { writeFileSync } from 'node:fs';",
      "import { fileURLToPath } from 'node:url';",
      'export default function apply() {',
      `  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ entry: fileURLToPath(import.meta.url) }));`,
      '}',
    ].join('\n'));

    const withoutPlugin = await callDeepSeekHarness('worker', 'Return ok.', {
      cwd: workspace,
      providerOptions: { baseUrl: api.endpoint },
    });
    expect(withoutPlugin.status).toBe('done');
    expect(existsSync(marker)).toBe(false);

    const withPlugin = await callDeepSeekHarness('worker', 'Return ok.', {
      cwd: workspace,
      providerOptions: {
        baseUrl: api.endpoint,
        plugins: [`npm:file:${packageDirectory}`],
      },
    });
    expect(withPlugin.status).toBe('done');
    const loadedPlugin = JSON.parse(await readFile(marker, 'utf8')) as { entry: string };
    expect(path.isAbsolute(loadedPlugin.entry)).toBe(true);
    expect(existsSync(loadedPlugin.entry)).toBe(true);
    expect(api.requests).toHaveLength(2);
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME).each(['exports', 'main'] as const)(
    'installs an npm plugin from a local package and loads its %s entry in the official runtime',
    async (entryField) => {
      const api = await startLocalApi();
      const workspace = join(temporaryRoot, `npm-plugin-${entryField}-workspace`);
      const packageDirectory = join(temporaryRoot, `npm-plugin-${entryField}-package`);
      const marker = join(temporaryRoot, `npm-plugin-${entryField}-loaded`);
      const lifecycleScriptMarker = join(temporaryRoot, `npm-plugin-${entryField}-install-script`);
      const alternativePackageDirectory = join(temporaryRoot, `npm-plugin-${entryField}-alternative-package`);
      const settingsPath = join(process.env.DSH_HOME!, 'settings.yaml');
      const piSettingsPath = join(process.env.PI_CODING_AGENT_DIR!, 'settings.json');
      const existingSettings = '# user-owned DeepSeek settings must remain unchanged\n';
      const existingPiSettings = JSON.stringify({ theme: 'dark', extensions: ['user-extension'] });
      await mkdir(workspace, { recursive: true });
      await mkdir(packageDirectory, { recursive: true });
      await mkdir(alternativePackageDirectory, { recursive: true });
      await writeFile(settingsPath, existingSettings);
      await writeFile(piSettingsPath, existingPiSettings);
      await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
        name: `local-${entryField}-cordis-plugin`,
        version: '1.0.0',
        type: 'module',
        scripts: {
          install: `node -e 'require("node:fs").writeFileSync(${JSON.stringify(lifecycleScriptMarker)}, "ran")'`,
        },
        ...(entryField === 'exports' ? { exports: { '.': './index.js' } } : { main: './index.js' }),
      }));
      await writeFile(join(packageDirectory, 'index.js'), [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "import { fileURLToPath } from 'node:url';",
        'export default function apply(_ctx, config) {',
        "  const patchIndex = process.argv.indexOf('--patch');",
        '  const patchPath = patchIndex < 0 ? undefined : process.argv[patchIndex + 1];',
        '  const patch = patchPath === undefined ? "" : readFileSync(patchPath, "utf8");',
        "  writeFileSync(config.marker, JSON.stringify({ value: config.value, entry: fileURLToPath(import.meta.url), patch }));",
        '}',
      ].join('\n'));
      await writeFile(join(alternativePackageDirectory, 'package.json'), JSON.stringify({
        name: `local-${entryField}-alternative-plugin`,
        version: '1.0.0',
        type: 'module',
        main: './index.js',
      }));
      await writeFile(join(alternativePackageDirectory, 'index.js'), 'export default function apply() {}');

      const source = `npm:file:${packageDirectory}`;
      const options = {
        cwd: workspace,
        providerOptions: {
          baseUrl: api.endpoint,
          plugins: [{
            ...(entryField === 'main' ? { id: 'npm-fixture-plugin' } : {}),
            source,
            config: { marker, value: 'loaded' },
          }],
        },
      };
      const pluginDirectoriesBefore = (await readdir(tmpdir()))
        .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));
      try {
        const result = await callDeepSeekHarness('worker', 'Return ok.', options);
        expect(result.status).toBe('done');
        expect(result.sessionId).toEqual(expect.any(String));
        const loadedPlugin = JSON.parse(await readFile(marker, 'utf8')) as {
          value: string;
          entry: string;
          patch: string;
        };
        expect(loadedPlugin.value).toBe('loaded');
        expect(path.isAbsolute(loadedPlugin.entry)).toBe(true);
        expect(existsSync(loadedPlugin.entry)).toBe(true);
        const pluginDirectoriesAfterLoad = (await readdir(tmpdir()))
          .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));
        const createdPluginDirectories = pluginDirectoriesAfterLoad
          .filter((entry) => !pluginDirectoriesBefore.includes(entry));
        expect(createdPluginDirectories).toHaveLength(1);
        const runtimePatch = parseYaml(loadedPlugin.patch) as Array<Record<string, unknown>>;
        expect(runtimePatch.slice(0, 4).map((entry) => entry.id)).toEqual([
          'credentials',
          'llm-deepseek',
          'session-persistence-jsonl',
          'session-log-deepseek',
        ]);
        const insertedPlugins = runtimePatch.flatMap((entry) =>
          Array.isArray(entry.insert) ? entry.insert as Array<Record<string, unknown>> : []);
        expect(insertedPlugins).toContainEqual({
          ...(entryField === 'main' ? { id: 'npm-fixture-plugin' } : {}),
          name: pathToFileURL(loadedPlugin.entry).href,
          config: { marker, value: 'loaded' },
        });
        expect(await readFile(settingsPath, 'utf8')).toBe(existingSettings);
        expect(await readFile(piSettingsPath, 'utf8')).toBe(existingPiSettings);
        expect(existsSync(lifecycleScriptMarker)).toBe(false);

        const changedConfig = await callDeepSeekHarness('worker', 'Do not reuse the prior plugin process.', {
          ...options,
          sessionId: result.sessionId,
          providerOptions: {
            ...options.providerOptions,
            plugins: [{
              ...(entryField === 'main' ? { id: 'npm-fixture-plugin' } : {}),
              source,
              config: { marker, value: 'changed' },
            }],
          },
        });
        expect(changedConfig).toMatchObject({
          status: 'error',
          failureCategory: 'session_continuation_unsupported',
        });
        const changedSource = await callDeepSeekHarness('worker', 'Do not replace the prior plugin source.', {
          ...options,
          sessionId: result.sessionId,
          providerOptions: {
            ...options.providerOptions,
            plugins: [{
              ...(entryField === 'main' ? { id: 'npm-fixture-plugin' } : {}),
              source: `npm:file:${alternativePackageDirectory}`,
              config: { marker, value: 'loaded' },
            }],
          },
        });
        expect(changedSource).toMatchObject({ status: 'error', failureCategory: 'session_continuation_unsupported' });
        const changedId = await callDeepSeekHarness('worker', 'Do not replace the prior plugin ID.', {
          ...options,
          sessionId: result.sessionId,
          providerOptions: {
            ...options.providerOptions,
            plugins: [{ id: 'different-npm-plugin-id', source, config: { marker, value: 'loaded' } }],
          },
        });
        expect(changedId).toMatchObject({ status: 'error', failureCategory: 'session_continuation_unsupported' });
        expect(api.requests).toHaveLength(1);
        await closeDeepSeekHarnessProcesses();
        expect((await readdir(tmpdir()))
          .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-')))
          .toEqual(pluginDirectoriesBefore);
        expect(await readFile(settingsPath, 'utf8')).toBe(existingSettings);
        expect(await readFile(piSettingsPath, 'utf8')).toBe(existingPiSettings);
      } finally {
        await closeDeepSeekHarnessProcesses();
      }
    },
  );

  it.skipIf(!SUPPORTED_RUNTIME)('resolves relative npm package sources from the original working directory', async () => {
    const api = await startLocalApi();
    const projectDirectory = join(temporaryRoot, 'relative-npm-project');
    const packageDirectory = join(projectDirectory, 'fixtures', 'trusted-plugin');
    const fakeNpmDirectory = join(temporaryRoot, 'relative-npm-bin');
    const marker = join(temporaryRoot, 'relative-npm-plugin-loaded.json');
    const temporaryCwdMarker = join(temporaryRoot, 'relative-npm-temporary-cwd.txt');
    const workspace = join(temporaryRoot, 'relative-npm-runtime');
    const realNpm = execFileSync('which', ['npm'], { encoding: 'utf8' }).trim();
    await mkdir(packageDirectory, { recursive: true });
    await mkdir(fakeNpmDirectory, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'takt-relative-source-plugin',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    await writeFile(join(packageDirectory, 'index.js'), [
      "import { writeFileSync } from 'node:fs';",
      'export default function apply() {',
      `  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ origin: 'original-project' }));`,
      '}',
    ].join('\n'));
    const decoySource = [
      "const { writeFileSync } = require('node:fs');",
      'module.exports = function apply() {',
      `  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ origin: 'temporary-cwd' }));`,
      '};',
    ].join('\n');
    const fakeNpm = join(fakeNpmDirectory, 'npm');
    await writeFile(fakeNpm, [
      '#!/usr/bin/env node',
      "const { spawnSync } = require('node:child_process');",
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      'const args = process.argv.slice(2);',
      "if (args[0] === 'pack' && process.cwd().includes('takt-deepseek-npm-plugin-')) {",
      "  const decoy = join(process.cwd(), 'fixtures', 'trusted-plugin');",
      '  mkdirSync(decoy, { recursive: true });',
      `  writeFileSync(${JSON.stringify(temporaryCwdMarker)}, process.cwd());`,
      "  writeFileSync(join(decoy, 'package.json'), JSON.stringify({ name: 'takt-relative-source-decoy', version: '1.0.0', main: './index.js' }));",
      `  writeFileSync(join(decoy, 'index.js'), ${JSON.stringify(decoySource)});`,
      '}',
      'const result = spawnSync(process.env.TAKT_TEST_REAL_NPM, args, { stdio: \'inherit\' });',
      'if (result.error) throw result.error;',
      'process.exitCode = result.status ?? 1;',
    ].join('\n'));
    await chmod(fakeNpm, 0o755);

    const previousCwd = process.cwd();
    const environment = new Map(['PATH', 'TAKT_TEST_REAL_NPM'].map((key) => [key, process.env[key]!]));
    const pluginDirectoriesBefore = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));
    try {
      process.env.PATH = `${fakeNpmDirectory}${path.delimiter}${process.env.PATH ?? ''}`;
      process.env.TAKT_TEST_REAL_NPM = realNpm;
      process.chdir(projectDirectory);
      const response = await callDeepSeekHarness('worker', 'Load the relative local npm plugin.', {
        cwd: workspace,
        providerOptions: { baseUrl: api.endpoint, plugins: ['npm:./fixtures/trusted-plugin'] },
      });
      expect(response, `Relative npm source response: ${JSON.stringify(response)}`).toMatchObject({ status: 'done' });
      expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({ origin: 'original-project' });
      expect(await readFile(temporaryCwdMarker, 'utf8')).toContain('takt-deepseek-npm-plugin-');
      await closeDeepSeekHarnessProcesses();
      expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-')))
        .toEqual(pluginDirectoriesBefore);
    } finally {
      await closeDeepSeekHarnessProcesses().catch(() => undefined);
      process.chdir(previousCwd);
      for (const [key, value] of environment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 90_000);

  it.skipIf(!SUPPORTED_RUNTIME)('loads npm packages and dependencies from trusted configuration despite a project registry override', async () => {
    const api = await startLocalApi();
    const pluginName = 'takt-npm-cwd-boundary-plugin';
    const dependencyName = 'takt-npm-cwd-boundary-dependency';
    const fixtureRoot = join(temporaryRoot, 'npm-registry-fixtures');
    const projectRoot = join(fixtureRoot, 'project');
    const trustedPackages: LocalNpmPackage[] = [];
    const projectPackages: LocalNpmPackage[] = [];
    for (const [label, packageRoot, destination, target] of [
      ['trusted', join(fixtureRoot, 'trusted-source'), join(fixtureRoot, 'trusted-tarballs'), trustedPackages],
      ['project', join(fixtureRoot, 'project-source'), join(fixtureRoot, 'project-tarballs'), projectPackages],
    ] as const) {
      const dependencyDirectory = join(packageRoot, dependencyName);
      const pluginDirectory = join(packageRoot, pluginName);
      await mkdir(dependencyDirectory, { recursive: true });
      await mkdir(pluginDirectory, { recursive: true });
      await mkdir(destination, { recursive: true });
      await writeFile(join(dependencyDirectory, 'package.json'), JSON.stringify({
        name: dependencyName,
        version: '1.0.0',
        type: 'module',
        exports: './index.js',
      }));
      await writeFile(join(dependencyDirectory, 'index.js'), `export const origin = ${JSON.stringify(`${label}-dependency`)};\n`);
      await writeFile(join(pluginDirectory, 'package.json'), JSON.stringify({
        name: pluginName,
        version: '1.0.0',
        type: 'module',
        main: './index.js',
        dependencies: { [dependencyName]: '1.0.0' },
      }));
      await writeFile(join(pluginDirectory, 'index.js'), [
        `import { origin as dependencyOrigin } from ${JSON.stringify(dependencyName)};`,
        "import { writeFileSync } from 'node:fs';",
        'export default function apply(_ctx, config) {',
        `  writeFileSync(config.marker, JSON.stringify({ packageOrigin: ${JSON.stringify(`${label}-package`)}, dependencyOrigin }));`,
        '}',
      ].join('\n'));
      target.push(
        await packLocalNpmPackage(dependencyDirectory, destination),
        await packLocalNpmPackage(pluginDirectory, destination),
      );
    }
    const trustedRegistry = await startLocalNpmRegistry(trustedPackages);
    const projectRegistry = await startLocalNpmRegistry(projectPackages);
    const userConfig = join(temporaryRoot, 'trusted.npmrc');
    await writeFile(userConfig, `registry=${trustedRegistry.endpoint}/\n`);
    const previousCwd = process.cwd();
    const npmEnvironmentKeys = [
      'NPM_CONFIG_USERCONFIG',
      'NPM_CONFIG_REGISTRY',
      'npm_config_userconfig',
      'npm_config_registry',
      'npm_config_cache',
    ] as const;
    const previousNpmEnvironment = new Map(npmEnvironmentKeys.map((key) => [key, process.env[key]]));
    try {
      process.env.NPM_CONFIG_USERCONFIG = userConfig;
      process.env.npm_config_userconfig = userConfig;
      delete process.env.NPM_CONFIG_REGISTRY;
      delete process.env.npm_config_registry;
      for (const [label, useProjectRegistry] of [['without-project-config', false], ['with-project-config', true]] as const) {
        const projectDirectory = join(projectRoot, label);
        const marker = join(temporaryRoot, `${label}-loaded.json`);
        const workspace = join(temporaryRoot, `${label}-runtime`);
        await mkdir(projectDirectory, { recursive: true });
        await mkdir(workspace, { recursive: true });
        if (useProjectRegistry) {
          await writeFile(join(projectDirectory, '.npmrc'), `registry=${projectRegistry.endpoint}/\n`);
        }
        process.env.npm_config_cache = join(temporaryRoot, `${label}-npm-cache`);
        process.chdir(projectDirectory);
        const response = await callDeepSeekHarness('worker', 'Load the trusted npm fixture.', {
          cwd: workspace,
          providerOptions: {
            baseUrl: api.endpoint,
            plugins: [{ source: `npm:${pluginName}@1.0.0`, config: { marker } }],
          },
        });
        expect(response, `${label} project config response: ${JSON.stringify(response)}`).toMatchObject({ status: 'done' });
        expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({
          packageOrigin: 'trusted-package',
          dependencyOrigin: 'trusted-dependency',
        });
        await closeDeepSeekHarnessProcesses();
      }
      expect(trustedRegistry.requests).toContain(dependencyName);
      expect(trustedRegistry.requests).toContain(pluginName);
      expect(projectRegistry.requests).toEqual([]);
      expect(api.requests).toHaveLength(2);
    } finally {
      await closeDeepSeekHarnessProcesses().catch(() => undefined);
      process.chdir(previousCwd);
      for (const key of npmEnvironmentKeys) {
        const value = previousNpmEnvironment.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 120_000);

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
    const packageDirectory = join(temporaryRoot, 'active-turn-abort-plugin');
    const pluginLoadedPath = join(temporaryRoot, 'active-turn-abort-plugin-loaded');
    await mkdir(workspace, { recursive: true });
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'local-active-turn-abort-plugin',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    }));
    await writeFile(join(packageDirectory, 'index.js'), [
      "import { writeFileSync } from 'node:fs';",
      'export default function apply() {',
      `  writeFileSync(${JSON.stringify(pluginLoadedPath)}, 'loaded');`,
      '}',
    ].join('\n'));
    const abortController = new AbortController();
    const pluginDirectoriesBefore = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));
    const continuationOptions = {
      cwd: workspace,
      providerOptions: {
        requestTimeoutMs: 30_000,
        baseUrl: api.endpoint,
        plugins: [`npm:file:${packageDirectory}`],
      },
    };
    const initial = await callDeepSeekHarness('worker', 'start before aborting', continuationOptions);
    expect(initial).toMatchObject({ status: 'done', sessionId: expect.any(String) });
    expect(await readFile(pluginLoadedPath, 'utf8')).toBe('loaded');
    const pluginDirectoriesAfterLoad = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-'));
    const createdPluginDirectories = pluginDirectoriesAfterLoad
      .filter((entry) => !pluginDirectoriesBefore.includes(entry));
    expect(createdPluginDirectories).toHaveLength(1);
    const [pluginDirectory] = createdPluginDirectories;
    if (pluginDirectory === undefined) throw new Error('npm plugin temporary directory was not created');
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
    await waitForPathRemoval(join(tmpdir(), pluginDirectory));
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-npm-plugin-')))
      .toEqual(pluginDirectoriesBefore);
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

  it.skipIf(!SUPPORTED_RUNTIME).each([false, true])('keeps an aborted call classified while cleanup blocks another runtime start (repeated SDK close succeeds=%s)', async (repeatedCloseSucceeds) => {
    let signalRunStarted: () => void = () => {};
    const runStarted = new Promise<void>((resolve) => { signalRunStarted = resolve; });
    vi.spyOn(DeepSeekHarness.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(DeepSeekHarness.prototype, 'run').mockImplementation(async () => {
      signalRunStarted();
      return await new Promise<never>(() => {});
    });
    let releaseRepeatedClose: () => void = () => {};
    const repeatedCloseCanFinish = new Promise<void>((resolve) => { releaseRepeatedClose = resolve; });
    let closeCalls = 0;
    let delayStrictAcknowledgement = false;
    let strictAcknowledgementPending = false;
    let releaseStrictAcknowledgement: () => void = () => {};
    const strictAcknowledgementCanFinish = new Promise<void>((resolve) => { releaseStrictAcknowledgement = resolve; });
    const realAcknowledgement = runtimeState.acknowledgeDeepSeekRuntimeCleanup;
    vi.spyOn(runtimeState, 'acknowledgeDeepSeekRuntimeCleanup').mockImplementation(async (confirmationPath) => {
      if (delayStrictAcknowledgement) {
        delayStrictAcknowledgement = false;
        strictAcknowledgementPending = true;
        await strictAcknowledgementCanFinish;
      }
      return realAcknowledgement(confirmationPath);
    });
    vi.spyOn(DeepSeekHarness.prototype, 'close').mockImplementation(async () => {
      // Let the supervisor watcher reconcile before a repeated SDK close returns.
      if (++closeCalls > 1) {
        await repeatedCloseCanFinish;
        if (repeatedCloseSucceeds) return;
      }
      throw new Error('simulated unconfirmed shutdown');
    });

    const abortController = new AbortController();
    const operation = callDeepSeekHarness('worker', 'abort while runtime cleanup is pending', {
      cwd: temporaryRoot,
      abortSignal: abortController.signal,
    });
    let child: ReturnType<typeof spawn> | undefined;
    let receiptPath: string | undefined;
    let ownerPath: string | undefined;
    let cleanupPaths: string[] = [];

    try {
      await runStarted;
      const options = sdkConstructorOptions[0];
      const runtimePaths = getDeepSeekRuntimePaths();
      const cleanupConfirmation = options?.env?.TAKT_DSH_CLEANUP_CONFIRMATION;
      const cleanupPathList = options?.env?.TAKT_DSH_CLEANUP_PATHS;
      if (typeof cleanupConfirmation !== 'string' || typeof cleanupPathList !== 'string') {
        throw new Error('DeepSeek Harness did not receive cleanup ownership paths');
      }
      receiptPath = cleanupConfirmation;
      cleanupPaths = JSON.parse(cleanupPathList) as string[];
      const firstCleanupPath = cleanupPaths[0];
      if (firstCleanupPath === undefined) throw new Error('DeepSeek Harness cleanup paths were empty');
      const cleanupBarrierPath = join(runtimePaths.state, 'cleanup-blocked');
      ownerPath = join(runtimePaths.owners, 'aborted-runtime.json');
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      await new Promise<void>((resolve, reject) => {
        child?.once('error', reject);
        child?.once('spawn', resolve);
      });
      if (child.pid === undefined) throw new Error('Delayed cleanup runtime did not start');
      await mkdir(runtimePaths.owners, { recursive: true });
      await writeFile(ownerPath, JSON.stringify({
        parentPid: process.pid,
        supervisorPid: process.pid,
        runtimePid: child.pid,
        cleanupPaths,
        cleanupConfirmationPath: receiptPath,
        cleanupRoot: dirname(firstCleanupPath),
      }));

      abortController.abort(new Error('test aborted active DeepSeek turn'));
      await waitForFile(cleanupBarrierPath, 30_000);
      expect(existsSync(cleanupPaths[0]!)).toBe(true);
      const constructedBeforeRetry = sdkConstructorOptions.length;
      const retryAbortController = new AbortController();
      const retryAbortTimeout = setTimeout(
        () => retryAbortController.abort(new Error('bounded cleanup-barrier retry')),
        500,
      );
      let blocked: Awaited<ReturnType<typeof callDeepSeekHarness>>;
      try {
        blocked = await callDeepSeekHarness('worker', 'must wait for cleanup receipt', {
          cwd: temporaryRoot,
          abortSignal: retryAbortController.signal,
        });
      } finally {
        clearTimeout(retryAbortTimeout);
      }
      expect(blocked.status).toBe('error');
      expect(sdkConstructorOptions).toHaveLength(constructedBeforeRetry);
      expect(existsSync(cleanupBarrierPath)).toBe(true);

      delayStrictAcknowledgement = repeatedCloseSucceeds;
      process.kill(-child.pid, 'SIGTERM');
      await waitForExit(child);
      await mkdir(dirname(receiptPath), { recursive: true });
      await writeFile(receiptPath, 'confirmed\n', { mode: 0o600 });
      if (repeatedCloseSucceeds) {
        await vi.waitFor(() => expect(strictAcknowledgementPending).toBe(true));
        // Another state owner consumes the proven-exit receipt while the strict watcher is pending.
        expect(await realAcknowledgement(receiptPath)).toBe(true);
        releaseRepeatedClose();
        await new Promise<void>((resolve) => setImmediate(resolve));
        releaseStrictAcknowledgement();
      } else {
        await waitForPathRemoval(cleanupPaths[0]!);
        await waitForPathRemoval(ownerPath);
        releaseRepeatedClose();
      }
      const aborted = await operation;

      expect(aborted).toMatchObject({ status: 'error', failureCategory: 'external_abort' });
      await waitForPathRemoval(cleanupPaths[0]!);
      await waitForPathRemoval(ownerPath);
      await waitForPathRemoval(cleanupBarrierPath);
    } finally {
      if (!abortController.signal.aborted) {
        abortController.abort(new Error('cleanup test finished'));
      }
      if (child !== undefined && child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The runtime has already exited. */ }
        await waitForExit(child);
      }
      if (receiptPath !== undefined) {
        await mkdir(dirname(receiptPath), { recursive: true });
        await writeFile(receiptPath, 'confirmed\n', { mode: 0o600 });
      }
      releaseRepeatedClose();
      releaseStrictAcknowledgement();
      await operation;
      for (const cleanupPath of cleanupPaths) {
        await waitForPathRemoval(cleanupPath, 10_000).catch(() => undefined);
      }
      if (ownerPath !== undefined) await rm(ownerPath, { force: true });
      await closeDeepSeekHarnessProcesses().catch(() => undefined);
    }
  }, 60_000);

  it.skipIf(!SUPPORTED_RUNTIME)('keeps a timed-out call classified while cleanup blocks another runtime start', async () => {
    let signalRunStarted: () => void = () => {};
    const runStarted = new Promise<void>((resolve) => { signalRunStarted = resolve; });
    let rejectRun: (error: Error) => void = () => {};
    const runPending = new Promise<never>((_resolve, reject) => { rejectRun = reject; });
    const timeoutError = new RequestTimeoutError('simulated SDK request timeout');
    vi.spyOn(DeepSeekHarness.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(DeepSeekHarness.prototype, 'run').mockImplementation(async () => {
      signalRunStarted();
      return await runPending;
    });
    let releaseRepeatedClose: () => void = () => {};
    const repeatedCloseCanFinish = new Promise<void>((resolve) => { releaseRepeatedClose = resolve; });
    let closeCalls = 0;
    vi.spyOn(DeepSeekHarness.prototype, 'close').mockImplementation(async () => {
      // Let the supervisor watcher reconcile before a repeated SDK close returns.
      if (++closeCalls > 1) await repeatedCloseCanFinish;
      throw new Error('simulated unconfirmed shutdown');
    });

    const operation = callDeepSeekHarness('worker', 'time out while runtime cleanup is pending', {
      cwd: temporaryRoot,
    });
    let child: ReturnType<typeof spawn> | undefined;
    let receiptPath: string | undefined;
    let ownerPath: string | undefined;
    let cleanupPaths: string[] = [];
    let timeoutTriggered = false;

    try {
      await runStarted;
      const options = sdkConstructorOptions[0];
      const runtimePaths = getDeepSeekRuntimePaths();
      const cleanupConfirmation = options?.env?.TAKT_DSH_CLEANUP_CONFIRMATION;
      const cleanupPathList = options?.env?.TAKT_DSH_CLEANUP_PATHS;
      if (typeof cleanupConfirmation !== 'string' || typeof cleanupPathList !== 'string') {
        throw new Error('DeepSeek Harness did not receive cleanup ownership paths');
      }
      receiptPath = cleanupConfirmation;
      cleanupPaths = JSON.parse(cleanupPathList) as string[];
      const firstCleanupPath = cleanupPaths[0];
      if (firstCleanupPath === undefined) throw new Error('DeepSeek Harness cleanup paths were empty');
      const cleanupBarrierPath = join(runtimePaths.state, 'cleanup-blocked');
      ownerPath = join(runtimePaths.owners, 'timed-out-runtime.json');
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      await new Promise<void>((resolve, reject) => {
        child?.once('error', reject);
        child?.once('spawn', resolve);
      });
      if (child.pid === undefined) throw new Error('Delayed cleanup runtime did not start');
      await mkdir(runtimePaths.owners, { recursive: true });
      await writeFile(ownerPath, JSON.stringify({
        parentPid: process.pid,
        supervisorPid: process.pid,
        runtimePid: child.pid,
        cleanupPaths,
        cleanupConfirmationPath: receiptPath,
        cleanupRoot: dirname(firstCleanupPath),
      }));

      timeoutTriggered = true;
      rejectRun(timeoutError);
      await waitForFile(cleanupBarrierPath, 30_000);
      expect(existsSync(cleanupPaths[0]!)).toBe(true);
      const constructedBeforeRetry = sdkConstructorOptions.length;
      const retryAbortController = new AbortController();
      const retryAbortTimeout = setTimeout(
        () => retryAbortController.abort(new Error('bounded cleanup-barrier retry')),
        500,
      );
      let blocked: Awaited<ReturnType<typeof callDeepSeekHarness>>;
      try {
        blocked = await callDeepSeekHarness('worker', 'must wait for cleanup receipt', {
          cwd: temporaryRoot,
          abortSignal: retryAbortController.signal,
        });
      } finally {
        clearTimeout(retryAbortTimeout);
      }
      expect(blocked.status).toBe('error');
      expect(sdkConstructorOptions).toHaveLength(constructedBeforeRetry);
      expect(existsSync(cleanupBarrierPath)).toBe(true);

      process.kill(-child.pid, 'SIGTERM');
      await waitForExit(child);
      await mkdir(dirname(receiptPath), { recursive: true });
      await writeFile(receiptPath, 'confirmed\n', { mode: 0o600 });
      await waitForPathRemoval(cleanupPaths[0]!);
      await waitForPathRemoval(ownerPath);
      releaseRepeatedClose();
      const timedOut = await operation;

      expect(timedOut).toMatchObject({ status: 'error', failureCategory: 'part_timeout' });
      await waitForPathRemoval(cleanupPaths[0]!);
      await waitForPathRemoval(ownerPath);
      await waitForPathRemoval(cleanupBarrierPath);
    } finally {
      if (!timeoutTriggered) rejectRun(timeoutError);
      if (child !== undefined && child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The runtime has already exited. */ }
        await waitForExit(child);
      }
      if (receiptPath !== undefined) {
        await mkdir(dirname(receiptPath), { recursive: true });
        await writeFile(receiptPath, 'confirmed\n', { mode: 0o600 });
      }
      releaseRepeatedClose();
      await operation;
      for (const cleanupPath of cleanupPaths) {
        await waitForPathRemoval(cleanupPath, 10_000).catch(() => undefined);
      }
      if (ownerPath !== undefined) await rm(ownerPath, { force: true });
      await closeDeepSeekHarnessProcesses().catch(() => undefined);
    }
  }, 60_000);

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
    if (offlineManagedNpmCache !== undefined) {
      process.env.NPM_CONFIG_CACHE = offlineManagedNpmCache;
      process.env.npm_config_cache = offlineManagedNpmCache;
      process.env.NPM_CONFIG_OFFLINE = 'true';
      process.env.npm_config_offline = 'true';
    } else {
      process.env.npm_config_cache = join(temporaryRoot, 'npm-cache');
    }
    process.env.npm_config_ignore_scripts = 'true';
    await installDeepSeekHarness();
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
      TAKT_DSH_MANAGED_PACKAGE_DIRECTORY: fileURLToPath(new URL('../..', import.meta.url)),
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

  it.skipIf(!SUPPORTED_RUNTIME).each(['hoisted', 'nested', 'nested-with-hoisted-decoy'] as const)(
    'resolves the diagnostic boot dependency from the runtime with %s packages',
    async (layout) => {
      const managedDirectory = join(temporaryRoot, 'managed-runtime');
      const runtimeDirectory = join(managedDirectory, 'node_modules/@deepseek-ai/dsh');
      await mkdir(join(runtimeDirectory, 'lib'), { recursive: true });
      await writeFile(join(managedDirectory, 'package.json'), '{}');
      await writeFile(join(runtimeDirectory, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh', type: 'module', bin: { dsh: 'lib/bin.js' },
      }));
      await writeFile(join(runtimeDirectory, 'lib/bin.js'), 'process.stdout.write(process.env.TAKT_DSH_RUNTIME_BOOT_MODULE);');
      const bootDirectories = [join(
        layout === 'hoisted' ? managedDirectory : runtimeDirectory,
        'node_modules/@deepseek-ai/dsh-app-boot',
      )];
      if (layout === 'nested-with-hoisted-decoy') {
        bootDirectories.push(join(managedDirectory, 'node_modules/@deepseek-ai/dsh-app-boot'));
      }
      for (const directory of bootDirectories) {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'package.json'), JSON.stringify({
          name: '@deepseek-ai/dsh-app-boot', type: 'module', exports: './index.js',
        }));
        await writeFile(join(directory, 'index.js'), 'export {};');
      }
      const paths = getDeepSeekRuntimePaths();
      const supervisorUrl = new URL('../infra/deepseek-harness/runtime-supervisor.mjs', import.meta.url).href;
      const result = await runSeparateParentProcess(`await import(${JSON.stringify(supervisorUrl)});`, {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        TAKT_DSH_OWNER_DIRECTORY: paths.owners,
        TAKT_DSH_STATE_DIRECTORY: paths.state,
        TAKT_DSH_PARENT_PID: String(process.pid),
        TAKT_DSH_MANAGED_PACKAGE_DIRECTORY: managedDirectory,
      }, 10_000, true);

      expect(result.timedOut).toBe(false);
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(await realpath(join(bootDirectories[0]!, 'index.js')));
      expect(await readdir(paths.owners)).toEqual([]);
    },
    15_000,
  );

  it.skipIf(!SUPPORTED_RUNTIME)('drains large runtime stderr output so shutdown can observe child exit', async () => {
    const paths = getDeepSeekRuntimePaths();
    const runtimeScript = 'process.stderr.write(Buffer.alloc(1024 * 1024), () => process.exit(0));';
    const supervisorUrl = new URL('../infra/deepseek-harness/runtime-supervisor.mjs', import.meta.url).href;
    const script = [
      "const childProcess = (await import('node:child_process')).default;",
      "const { syncBuiltinESMExports } = await import('node:module');",
      'const originalSpawn = childProcess.spawn;',
      `childProcess.spawn = (_command, _args, options) => originalSpawn(process.execPath, ['-e', ${JSON.stringify(runtimeScript)}], options);`,
      'syncBuiltinESMExports();',
      `await import(${JSON.stringify(supervisorUrl)});`,
    ].join('\n');
    const result = await runSeparateParentProcess(script, {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      TAKT_DSH_OWNER_DIRECTORY: paths.owners,
      TAKT_DSH_STATE_DIRECTORY: paths.state,
      TAKT_DSH_PARENT_PID: String(process.pid),
      TAKT_DSH_MANAGED_PACKAGE_DIRECTORY: fileURLToPath(new URL('../..', import.meta.url)),
    }, 8_000, true);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(await readdir(paths.owners)).toEqual([]);
  }, 15_000);

  it.skipIf(!SUPPORTED_RUNTIME).each([false, true])(
    'does not classify a spoofed Cordis diagnostic and exits after a bounded stderr drain (spoofed=%s)',
    async (spoofedDiagnostic) => {
      const paths = getDeepSeekRuntimePaths();
      const holderPidPath = join(temporaryRoot, 'stderr-holder-pid');
      const cleanupRoot = join(temporaryRoot, 'owned-runtime-resources');
      const cleanupPath = join(cleanupRoot, `takt-deepseek-descendant-resource-${spoofedDiagnostic}`);
      const cleanupConfirmationPath = join(paths.state, 'cleanup-receipts', `takt-deepseek-descendant-${spoofedDiagnostic}.confirmed`);
      await mkdir(cleanupPath, { recursive: true });
      await writeFile(join(cleanupPath, 'owned-resource'), 'must be removed');
      const entrypoint = pathToFileURL(join(temporaryRoot, 'failed-plugin.js')).href;
      const runtimeScript = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        "const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'ignore', 2] });",
        `writeFileSync(${JSON.stringify(holderPidPath)}, String(holder.pid));`,
        'holder.unref();',
        spoofedDiagnostic
          ? `process.stderr.write(${JSON.stringify(`dsh: warning: 1 entry did not activate\nnpm-cordis-load-failure (${entrypoint}): error: cordis fixture load failure\n`)}, () => process.exit(0));`
          : 'process.exit(0);',
      ].join('\n');
      const supervisorUrl = new URL('../infra/deepseek-harness/runtime-supervisor.mjs', import.meta.url).href;
      const script = [
        "const childProcess = (await import('node:child_process')).default;",
        "const { syncBuiltinESMExports } = await import('node:module');",
        'const originalSpawn = childProcess.spawn;',
        `childProcess.spawn = (_command, _args, options) => originalSpawn(process.execPath, ['-e', ${JSON.stringify(runtimeScript)}], options);`,
        'syncBuiltinESMExports();',
        `await import(${JSON.stringify(supervisorUrl)});`,
      ].join('\n');
      try {
        const result = await runSeparateParentProcess(script, {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          TAKT_DSH_OWNER_DIRECTORY: paths.owners,
          TAKT_DSH_STATE_DIRECTORY: paths.state,
          TAKT_DSH_PARENT_PID: String(process.pid),
          TAKT_DSH_MANAGED_PACKAGE_DIRECTORY: fileURLToPath(new URL('../..', import.meta.url)),
          TAKT_DSH_NPM_PLUGIN_ENTRYPOINTS: JSON.stringify([entrypoint]),
          TAKT_DSH_CLEANUP_PATHS: JSON.stringify([cleanupPath]),
          TAKT_DSH_CLEANUP_CONFIRMATION: cleanupConfirmationPath,
          TAKT_DSH_CLEANUP_ROOT: cleanupRoot,
        }, 8_000, true);
        const cleanupResourceExists = existsSync(cleanupPath);
        const cleanupReceipt = await readFile(cleanupConfirmationPath, 'utf8').catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        });
        const ownerEntriesBeforeAcknowledgement = await readdir(paths.owners);
        const ownerRecordsBeforeAcknowledgement = await Promise.all(ownerEntriesBeforeAcknowledgement.map(
          async (entry) => JSON.parse(await readFile(join(paths.owners, entry), 'utf8')) as {
            cleanupConfirmationPath?: string;
            cleanupPaths?: string[];
          },
        ));
        const matchingOwner = ownerRecordsBeforeAcknowledgement.find(
          (owner) => owner.cleanupConfirmationPath === cleanupConfirmationPath,
        );
        const acknowledgement = await acknowledgeDeepSeekRuntimeCleanup(cleanupConfirmationPath);
        const ownerEntriesAfterAcknowledgement = await readdir(paths.owners);
        const holderPid = Number(await readFile(holderPidPath, 'utf8'));
        let holderIsAlive = true;
        try {
          process.kill(holderPid, 0);
        } catch {
          holderIsAlive = false;
        }

        expect(result.timedOut).toBe(false);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
        expect(cleanupResourceExists).toBe(false);
        expect(cleanupReceipt).toBe('confirmed\n');
        expect(matchingOwner?.cleanupPaths).toContain(cleanupPath);
        expect(acknowledgement).toBe(true);
        expect(ownerEntriesAfterAcknowledgement).toEqual([]);
        // The escaped descendant is still alive: shutdown must not have depended on its stderr closing.
        expect(holderIsAlive).toBe(true);
      } finally {
        if (existsSync(holderPidPath)) {
          const holderPid = Number(await readFile(holderPidPath, 'utf8'));
          try { process.kill(-holderPid, 'SIGKILL'); } catch { /* Already stopped. */ }
        }
      }
    },
    15_000,
  );

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
      TAKT_DSH_MANAGED_PACKAGE_DIRECTORY: fileURLToPath(new URL('../..', import.meta.url)),
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
      TAKT_DSH_MANAGED_PACKAGE_DIRECTORY: fileURLToPath(new URL('../..', import.meta.url)),
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
    // This test deliberately corrupts the durable barrier; clear its isolated no-runtime fixture for teardown.
    await rm(join(runtimePaths.state, 'cleanup-blocked'), { force: true });
    await rm(join(runtimePaths.state, '.runtime-state-lock'), { recursive: true, force: true });
    const cleanupReceipt = sdkConstructorOptions.at(-1)?.env?.TAKT_DSH_CLEANUP_CONFIRMATION;
    if (typeof cleanupReceipt === 'string') {
      await mkdir(path.dirname(cleanupReceipt), { recursive: true });
      await writeFile(cleanupReceipt, 'confirmed\n');
    }
    await closeDeepSeekHarnessProcesses();
  });

  it.skipIf(!SUPPORTED_RUNTIME)('uses supervisor exit proof when SDK close rejects after actual group cleanup', async () => {
    const api = await startLocalApi();
    const options = { cwd: temporaryRoot, providerOptions: { reasoningEffort: 'low' as const, baseUrl: api.endpoint } };
    expect((await callDeepSeekHarness('worker', 'first live runtime', options)).status).toBe('done');
    const originalClose = DeepSeekHarness.prototype.close;
    const closeSpy = vi.spyOn(DeepSeekHarness.prototype, 'close').mockImplementation(async function (this: DeepSeekHarness) {
      await originalClose.call(this);
      const receiptPath = sdkConstructorOptions.at(-1)?.env?.TAKT_DSH_CLEANUP_CONFIRMATION;
      if (typeof receiptPath === 'string') await waitForFile(receiptPath, 10_000);
      throw new Error('SDK close rejected after confirmed process exit');
    });
    await expect(closeDeepSeekHarnessProcesses()).resolves.toBeUndefined();
    expect(await readdir(getDeepSeekRuntimePaths().owners)).toHaveLength(0);
    await expect(readFile(join(getDeepSeekRuntimePaths().state, 'cleanup-blocked'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    closeSpy.mockRestore();
    expect((await callDeepSeekHarness('worker', 'new live runtime', options)).status).toBe('done');
  }, 60_000);

  it.skipIf(process.platform === 'win32')('retains the Git clone and credential patch until a delayed exit receipt arrives', async () => {
    const pluginRepository = join(temporaryRoot, 'late-cleanup-plugin');
    await mkdir(pluginRepository);
    execFileSync('git', ['init', '-b', 'main'], { cwd: pluginRepository, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: pluginRepository });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: pluginRepository });
    await writeFile(join(pluginRepository, 'index.mjs'), 'export default class Plugin {}\n');
    execFileSync('git', ['add', 'index.mjs'], { cwd: pluginRepository });
    execFileSync('git', ['commit', '-m', 'plugin fixture'], { cwd: pluginRepository, stdio: 'ignore' });

    vi.spyOn(DeepSeekHarness.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(DeepSeekHarness.prototype, 'run').mockImplementation(async (_input, options) => {
      const sessionId = 'deferred-cleanup-session';
      options?.onNotification?.({
        method: 'session.event',
        params: {
          sessionId,
          event: {
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: 'completed' }] } },
          },
        },
      });
      options?.onNotification?.({
        method: 'session.event',
        params: { sessionId, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
      });
      return {
        sessionId,
        finalResponse: 'completed',
        events: [],
        notifications: [],
      };
    });
    let harness: DeepSeekHarness | undefined;
    vi.spyOn(DeepSeekHarness.prototype, 'close').mockImplementation(async function (this: DeepSeekHarness) {
      harness = this;
      throw new Error('simulated unconfirmed shutdown');
    });

    const response = await callDeepSeekHarness('worker', 'retain resources until confirmed exit', {
      cwd: temporaryRoot,
      providerOptions: {
        plugins: [{
          id: 'late-cleanup-plugin',
          source: pathToFileURL(pluginRepository).href,
          ref: 'main',
          config: { enabled: true },
        }],
      },
    });
    const patchPath = sdkConstructorOptions[0]?.patches?.[0];
    const receiptPath = sdkConstructorOptions[0]?.env?.TAKT_DSH_CLEANUP_CONFIRMATION;
    expect(typeof patchPath).toBe('string');
    expect(typeof receiptPath).toBe('string');
    if (typeof patchPath !== 'string' || typeof receiptPath !== 'string') {
      throw new Error('DeepSeek Harness did not receive managed resource paths');
    }

    const patch = parseYaml(await readFile(patchPath, 'utf8')) as Array<{
      insert?: Array<{ name?: string }>;
    }>;
    const pluginEntrypoint = patch.find((entry) => entry.insert !== undefined)?.insert?.[0]?.name;
    expect(typeof pluginEntrypoint).toBe('string');
    if (typeof pluginEntrypoint !== 'string') throw new Error('Credential patch did not include the Git plugin');
    const cloneDirectory = dirname(fileURLToPath(pluginEntrypoint));
    const runtimePaths = getDeepSeekRuntimePaths();
    const cleanupPaths = JSON.parse(String(sdkConstructorOptions[0]?.env?.TAKT_DSH_CLEANUP_PATHS)) as string[];
    const ownerPath = join(runtimePaths.owners, 'late-cleanup-runtime.json');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    if (child.pid === undefined) throw new Error('Delayed cleanup runtime did not start');
    await mkdir(runtimePaths.owners, { recursive: true });
    await writeFile(ownerPath, JSON.stringify({
      parentPid: process.pid,
      supervisorPid: process.pid,
      runtimePid: child.pid,
      cleanupPaths,
      cleanupConfirmationPath: receiptPath,
      cleanupRoot: dirname(cleanupPaths[0]!),
    }));

    try {
      expect(response.status).toBe('done');
      await expect(closeDeepSeekHarnessProcesses()).rejects.toThrow('cleanup is unconfirmed');
      expect(harness).toBeDefined();
      expect(existsSync(patchPath)).toBe(true);
      expect(existsSync(cloneDirectory)).toBe(true);
      expect(existsSync(join(runtimePaths.state, 'cleanup-blocked'))).toBe(true);

      process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM');
      await waitForExit(child);
      await mkdir(dirname(receiptPath), { recursive: true });
      await writeFile(receiptPath, 'confirmed\n', { mode: 0o600 });
      await waitForPathRemoval(cleanupPaths[0]!);
      await waitForPathRemoval(cleanupPaths[1]!);
      await waitForPathRemoval(ownerPath);
      expect(await readdir(runtimePaths.owners)).toHaveLength(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
        await waitForExit(child);
      }
      if (existsSync(cleanupPaths[0]!) || existsSync(cleanupPaths[1]!) || existsSync(ownerPath)) {
        await mkdir(dirname(receiptPath), { recursive: true });
        await writeFile(receiptPath, 'confirmed\n', { mode: 0o600 });
        await waitForPathRemoval(cleanupPaths[0]!, 10_000);
        await waitForPathRemoval(cleanupPaths[1]!, 10_000);
      }
      await rm(receiptPath, { force: true });
      await rm(ownerPath, { force: true });
    }
  });

  it.skipIf(!SUPPORTED_RUNTIME)('cleans resources in the supervisor after its parent exits', async () => {
    const runtimePaths = getDeepSeekRuntimePaths();
    const patchDirectory = await mkdtemp(join(tmpdir(), 'takt-deepseek-credentials-parent-exit-'));
    const pluginDirectory = await mkdtemp(join(tmpdir(), 'takt-deepseek-plugin-parent-exit-'));
    const cleanupPaths = [patchDirectory, pluginDirectory];
    const receiptPath = join(
      runtimePaths.state,
      'cleanup-receipts',
      `${path.basename(patchDirectory)}.confirmed`,
    );
    const runtimeStarted = join(temporaryRoot, 'parent-exit-runtime-started');
    const runtimeSignal = join(temporaryRoot, 'parent-exit-runtime-signal');
    const runtimePidMarker = join(temporaryRoot, 'parent-exit-runtime-pid');
    const releaseRuntime = join(temporaryRoot, 'parent-exit-runtime-release');
    const preloadPath = join(temporaryRoot, 'fake-runtime-preload.mjs');
    const fakeRuntime = [
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "import { setTimeout as delay } from 'node:timers/promises';",
      'const cleanupPaths = JSON.parse(process.env.TAKT_DSH_CLEANUP_PATHS);',
      `writeFileSync(${JSON.stringify(runtimeStarted)}, 'ready');`,
      `writeFileSync(${JSON.stringify(runtimePidMarker)}, String(process.pid));`,
      'process.on("SIGTERM", async () => {',
      `  writeFileSync(${JSON.stringify(runtimeSignal)}, cleanupPaths.every((path) => existsSync(path)) ? 'present' : 'missing');`,
      '  const deadline = Date.now() + 20000;',
      '  while (Date.now() < deadline) {',
      `    try { readFileSync(${JSON.stringify(releaseRuntime)}); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }`,
      '    await delay(10);',
      '  }',
      '  process.exit(0);',
      '});',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    await writeFile(preloadPath, [
      "import { syncBuiltinESMExports } from 'node:module';",
      "import childProcess from 'node:child_process';",
      'const originalSpawn = childProcess.spawn;',
      'childProcess.spawn = (command, args, options) => {',
      "  if (command === process.execPath && args?.some((argument) => typeof argument === 'string' && argument.includes('/@deepseek-ai/dsh/'))) {",
      `    return originalSpawn(process.execPath, ['-e', ${JSON.stringify(fakeRuntime)}], options);`,
      '  }',
      '  return originalSpawn(command, args, options);',
      '};',
      'syncBuiltinESMExports();',
    ].join('\n'));

    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: join(temporaryRoot, 'parent-exit-home'),
      TAKT_CONFIG_DIR: process.env.TAKT_CONFIG_DIR,
      DSH_HOME: process.env.DSH_HOME,
      TAKT_DSH_OWNER_DIRECTORY: runtimePaths.owners,
      TAKT_DSH_STATE_DIRECTORY: runtimePaths.state,
      TAKT_DSH_MANAGED_PACKAGE_DIRECTORY: fileURLToPath(new URL('../..', import.meta.url)),
      TAKT_DSH_CLEANUP_PATHS: JSON.stringify(cleanupPaths),
      TAKT_DSH_CLEANUP_CONFIRMATION: receiptPath,
      TAKT_DSH_CLEANUP_ROOT: dirname(patchDirectory),
      TEST_RUNTIME_SUPERVISOR: fileURLToPath(new URL('../infra/deepseek-harness/runtime-supervisor.mjs', import.meta.url)),
      TEST_SUPERVISOR_NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
      TEST_RUNTIME_STARTED: runtimeStarted,
      NO_COLOR: '1',
    };
    const parentScript = [
      "import { spawn } from 'node:child_process';",
      "import { existsSync } from 'node:fs';",
      "import { setTimeout as delay } from 'node:timers/promises';",
      'const childEnvironment = {',
      '  ...process.env,',
      '  NODE_OPTIONS: process.env.TEST_SUPERVISOR_NODE_OPTIONS,',
      '  TAKT_DSH_PARENT_PID: String(process.pid),',
      '};',
      'delete childEnvironment.TEST_SUPERVISOR_NODE_OPTIONS;',
      'const supervisor = spawn(process.execPath, [process.env.TEST_RUNTIME_SUPERVISOR], {',
      '  env: childEnvironment,',
      "  stdio: ['pipe', 'ignore', 'ignore'],",
      '});',
      'const deadline = Date.now() + 15000;',
      'while (Date.now() < deadline && !existsSync(process.env.TEST_RUNTIME_STARTED)) await delay(10);',
      'if (!existsSync(process.env.TEST_RUNTIME_STARTED)) process.exit(71);',
      'await new Promise((resolve) => process.stdout.write("supervisor-started", resolve));',
      'process.exit(0);',
    ].join('\n');

    let reconciled = false;
    try {
      const parent = await runSeparateParentProcess(parentScript, environment);
      expect(parent.timedOut).toBe(false);
      expect(parent.exitCode).toBe(0);
      expect(parent.stdout).toBe('supervisor-started');
      await waitForFile(runtimeSignal, 20_000);
      expect(await readFile(runtimeSignal, 'utf8')).toBe('present');
      expect(existsSync(patchDirectory)).toBe(true);
      expect(existsSync(pluginDirectory)).toBe(true);
      const ownerEntries = await readdir(runtimePaths.owners);
      expect(ownerEntries).toHaveLength(1);
      const ownerPath = join(runtimePaths.owners, ownerEntries[0]!);
      const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as {
        cleanupPaths?: string[];
        cleanupConfirmationPath?: string;
        cleanupRoot?: string;
        runtimePid?: number;
      };
      expect(owner).toMatchObject({
        cleanupPaths,
        cleanupConfirmationPath: receiptPath,
        cleanupRoot: dirname(patchDirectory),
        runtimePid: Number(await readFile(runtimePidMarker, 'utf8')),
      });
      await expect(readFile(receiptPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      await writeFile(releaseRuntime, 'exit');
      await waitForFile(receiptPath, 20_000);
      expect(existsSync(patchDirectory)).toBe(false);
      expect(existsSync(pluginDirectory)).toBe(false);
      expect(await readdir(runtimePaths.owners)).toHaveLength(1);

      await assertDeepSeekRuntimeCreationAllowed();
      expect(await readdir(runtimePaths.owners)).toHaveLength(0);
      await expect(readFile(receiptPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      reconciled = true;
    } finally {
      await writeFile(releaseRuntime, 'exit').catch(() => undefined);
      const runtimePid = Number(await readFile(runtimePidMarker, 'utf8').catch(() => ''));
      if (Number.isSafeInteger(runtimePid) && runtimePid > 0) {
        try { process.kill(-runtimePid, 'SIGKILL'); } catch { /* The group may already have exited. */ }
        const deadline = Date.now() + 5_000;
        let groupExited = false;
        while (Date.now() < deadline) {
          try {
            process.kill(-runtimePid, 0);
            await new Promise((resolve) => setTimeout(resolve, 10));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
              groupExited = true;
              break;
            }
            throw error;
          }
        }
        if (!groupExited) throw new Error('Fake runtime process group did not exit during test cleanup');
      }
      if (!reconciled && Number.isSafeInteger(runtimePid) && runtimePid > 0) {
        if (!existsSync(receiptPath)) await waitForFile(receiptPath, 20_000).catch(() => undefined);
        await assertDeepSeekRuntimeCreationAllowed().catch(() => undefined);
      }
      await rm(patchDirectory, { recursive: true, force: true });
      await rm(pluginDirectory, { recursive: true, force: true });
    }
  }, 90_000);

  it('reconciles cleanup paths from an exited owner record', async () => {
    const runtimePaths = getDeepSeekRuntimePaths();
    const patchDirectory = await mkdtemp(join(tmpdir(), 'takt-deepseek-credentials-dead-owner-'));
    const pluginDirectory = await mkdtemp(join(tmpdir(), 'takt-deepseek-plugin-dead-owner-'));
    const cleanupPaths = [patchDirectory, pluginDirectory];
    const receiptPath = join(
      runtimePaths.state,
      'cleanup-receipts',
      `${path.basename(patchDirectory)}.confirmed`,
    );
    await mkdir(runtimePaths.owners, { recursive: true });
    let runtimePid = process.pid + 100_000;
    while (true) {
      try {
        process.kill(-runtimePid, 0);
        runtimePid += 100_000;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        break;
      }
    }
    const ownerPath = join(runtimePaths.owners, 'dead-runtime-with-cleanup.json');
    await writeFile(ownerPath, JSON.stringify({
      parentPid: runtimePid,
      supervisorPid: runtimePid,
      runtimePid,
      cleanupPaths,
      cleanupConfirmationPath: receiptPath,
      cleanupRoot: dirname(cleanupPaths[0]!),
    }));

    try {
      await assertDeepSeekRuntimeCreationAllowed();
      expect(existsSync(patchDirectory)).toBe(false);
      expect(existsSync(pluginDirectory)).toBe(false);
      expect(await readdir(runtimePaths.owners)).toHaveLength(0);
      await expect(readFile(receiptPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(patchDirectory, { recursive: true, force: true });
      await rm(pluginDirectory, { recursive: true, force: true });
      await rm(ownerPath, { force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('reconciles an exited legacy owner without removing unowned resources', async () => {
    const runtimePaths = getDeepSeekRuntimePaths();
    const unownedResource = await mkdtemp(join(temporaryRoot, 'unowned-legacy-resource-'));
    const runtimePid = unusedProcessGroupPid();
    await mkdir(runtimePaths.owners, { recursive: true });
    const ownerPath = join(runtimePaths.owners, 'legacy-runtime.json');
    await writeFile(ownerPath, JSON.stringify({
      parentPid: runtimePid,
      supervisorPid: runtimePid,
      runtimePid,
    }));

    await assertDeepSeekRuntimeCreationAllowed();

    expect(existsSync(unownedResource)).toBe(true);
    expect(await readdir(runtimePaths.owners)).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32')('retains the owner and cleanup barrier when resource cleanup fails', async () => {
    const runtimePaths = getDeepSeekRuntimePaths();
    await mkdir(runtimePaths.state, { recursive: true });
    await mkdir(runtimePaths.owners, { recursive: true });
    const cleanupRoot = join(runtimePaths.state, 'cleanup-root-file');
    await writeFile(cleanupRoot, 'not a directory');
    const cleanupPath = join(cleanupRoot, 'takt-deepseek-cleanup-failure');
    const receiptPath = join(runtimePaths.state, 'cleanup-receipts', 'takt-deepseek-cleanup-failure.confirmed');
    const runtimePid = unusedProcessGroupPid();
    const ownerPath = join(runtimePaths.owners, 'cleanup-failure-runtime.json');
    await writeFile(ownerPath, JSON.stringify({
      parentPid: runtimePid,
      supervisorPid: runtimePid,
      runtimePid,
      cleanupPaths: [cleanupPath],
      cleanupConfirmationPath: receiptPath,
      cleanupRoot,
    }));

    await expect(assertDeepSeekRuntimeCreationAllowed()).rejects.toThrow('cleanup is unconfirmed');

    expect(JSON.parse(await readFile(ownerPath, 'utf8'))).toMatchObject({ cleanupFailed: true });
    expect(JSON.parse(await readFile(join(runtimePaths.state, 'cleanup-blocked'), 'utf8')))
      .toMatchObject({ runtimePids: expect.arrayContaining([runtimePid]), unknownRuntime: false });
    expect(existsSync(cleanupRoot)).toBe(true);
  });

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
