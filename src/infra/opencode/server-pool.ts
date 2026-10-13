import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '@opencode-ai/sdk/v2/types';
import { loadTemplate } from '../../shared/prompts/index.js';
import {
  getNestedObservabilityEnvFingerprint,
  runWithNestedObservabilityProcessEnv,
} from '../../shared/telemetry/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { versionAllowsListToolShim } from './list-tool-shim-guard.js';
import { cleanupPendingModelSelectionSessions } from './model-selection-session-cleanup.js';
import { startOpenCodeServer } from './server-process.js';
import { openCodeRuntimeSelection, resolveOpenCodeRuntime } from './runtime.js';
import { buildV2ServerConfig } from './v2-config.js';
import type { ManagedOpenCodeTransport, OpenCodeTransport } from './transport.js';
import type { OpenCodeExecutionContext } from './execution-context.js';

const OPENCODE_STREAM_ABORTED_MESSAGE = 'OpenCode execution aborted';
const OPENCODE_SERVER_START_TIMEOUT_MS = 60_000;
const TAKT_AGENT = 'takt';
const TAKT_AGENT_REVIEW = 'takt-review';
const TAKT_AGENT_REPORT = 'takt-report';
const TAKT_AGENT_READ = 'takt-read';
const log = createLogger('opencode-sdk');

export type OpencodeClient = OpenCodeTransport;

interface SharedServer {
  key: string;
  client: ManagedOpenCodeTransport;
  close: () => Promise<void>;
  onError: (listener: (error: Error) => void) => () => void;
  invalidated: boolean;
  invalidationController: AbortController;
  sessionBusy: Set<string>;
  sessionQueues: Map<string, SharedServerQueueEntry[]>;
}

interface SharedServerQueueEntry {
  resolve: (acquired: AcquiredOpenCodeClient) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
}

interface SharedServerEntry {
  server?: SharedServer;
  initPromise?: Promise<SharedServer>;
}

export class OpenCodeSharedServerInvalidationError extends Error {
  constructor(error: Error) {
    super(error.message);
    this.name = 'OpenCodeSharedServerInvalidationError';
  }
}

export interface AcquiredOpenCodeClient {
  client: OpencodeClient;
  release: () => void;
  invalidate: (error: Error) => void;
  invalidationSignal: AbortSignal;
  acquireSession: (
    sessionKey: string,
    abortSignal?: AbortSignal,
  ) => AcquiredOpenCodeClient | Promise<AcquiredOpenCodeClient>;
}

const sharedServers = new Map<string, SharedServerEntry>();
const ownedSharedServers = new Set<SharedServer>();
const pendingServerInitializations = new Set<Promise<SharedServer>>();
const serverStopFailures = new Set<Error>();
let forcedShutdownRequested = false;
let forcedShutdownPromise: Promise<void> | undefined;

function pluginPath(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'plugins', name);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error(OPENCODE_STREAM_ABORTED_MESSAGE);
}

function buildSharedServerKey(
  model: string | undefined,
  apiKey: string | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
  mcpIdentity: string | undefined,
  skillsEnabled: boolean,
): string {
  const runtime = openCodeRuntimeSelection();
  return JSON.stringify([model, apiKey, getNestedObservabilityEnvFingerprint(childProcessEnv), mcpIdentity ?? '', runtime,
    ...(runtime.generation === 'v2' ? [skillsEnabled] : []),
  ]);
}

function getSharedServerEntry(key: string): SharedServerEntry {
  const existing = sharedServers.get(key);
  if (existing !== undefined) return existing;
  const entry: SharedServerEntry = {};
  sharedServers.set(key, entry);
  return entry;
}

function getServerStopErrors(error: unknown, visited = new Set<unknown>()): Error[] {
  if (visited.has(error)) return [];
  visited.add(error);
  if (error instanceof Error && error.name === 'OpenCodeServerStopError') return [error];
  if (error instanceof AggregateError) {
    return [...error.errors].flatMap((nestedError) => getServerStopErrors(nestedError, visited));
  }
  if (error instanceof Error && error.cause !== undefined) {
    return getServerStopErrors(error.cause, visited);
  }
  return [];
}

function recordServerStopFailures(error: unknown): void {
  for (const stopError of getServerStopErrors(error)) serverStopFailures.add(stopError);
}

function reportServerCloseFailure(error: unknown, model: string | undefined): void {
  recordServerStopFailures(error);
  log.debug(`Failed to close OpenCode server: ${sanitizeSensitiveText(getErrorMessage(error))}`, { model });
}

function throwIfForcedShutdownRequested(): void {
  if (forcedShutdownRequested) throw new Error('OpenCode shared server pool is shutting down');
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) {
        server.close(() => reject(new Error('Failed to allocate free TCP port')));
        return;
      }
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function createSharedServer(
  key: string,
  model: string | undefined,
  apiKey: string | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
  serverConfig: Record<string, unknown> | undefined,
  skillsEnabled: boolean,
): Promise<SharedServer> {
  const runtime = await resolveOpenCodeRuntime();
  const port = await getFreePort();
  const registerListToolShim = runtime.generation === 'v1' && versionAllowsListToolShim(runtime.version);
  const openCodeServer = await runWithNestedObservabilityProcessEnv(childProcessEnv, () =>
    startOpenCodeServer({
      runtime,
      ...(runtime.generation === 'v2' ? { mcpServerNames: Object.keys(serverConfig ?? {}) } : {}),
      port,
      timeoutMs: OPENCODE_SERVER_START_TIMEOUT_MS,
      config: runtime.generation === 'v2' ? buildV2ServerConfig(model, apiKey, pluginPath('v2-session'), serverConfig, skillsEnabled) : {
        ...(model === undefined ? {} : { model, small_model: model }),
        plugin: [
          pluginPath('coerce-tool-args.js'),
          ...(registerListToolShim ? [pluginPath('list-tool.js')] : []),
        ],
        permission: { external_directory: 'deny' },
        ...(apiKey ? { provider: { opencode: { options: { apiKey } } } } : {}),
        agent: {
          [TAKT_AGENT]: {
            prompt: loadTemplate('opencode_agent_prompt', 'en', {
              listFilesMethod: 'runs bash ls to list files in the directory',
            }),
            tools: { task: false },
          },
          [TAKT_AGENT_REVIEW]: {
            prompt: loadTemplate('opencode_review_agent_prompt', 'en', {
              listFilesMethod: 'uses read tool on the directory to list files',
            }),
            tools: { task: false },
          },
          [TAKT_AGENT_REPORT]: {
            prompt: loadTemplate('opencode_report_agent_prompt', 'en'),
          },
          [TAKT_AGENT_READ]: {
            prompt: loadTemplate('opencode_read_agent_prompt', 'en'),
            tools: { task: false },
          },
        },
        ...(serverConfig !== undefined
          ? { mcp: serverConfig as NonNullable<Config['mcp']> }
          : {}),
      },
    }),
  );
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;

    let stopping: Promise<void>;
    try {
      stopping = Promise.resolve(openCodeServer.close()).then(
        () => {
          ownedSharedServers.delete(sharedServer);
        },
        (error: unknown) => {
          reportServerCloseFailure(error, model);
          throw error;
        },
      );
    } catch (error) {
      reportServerCloseFailure(error, model);
      stopping = Promise.reject(error);
    }
    closePromise = stopping;
    return stopping;
  };
  log.debug('OpenCode server started', { model, port });
  const sharedServer: SharedServer = {
    key,
    client: openCodeServer.client,
    close,
    onError: openCodeServer.onError,
    invalidated: false,
    invalidationController: new AbortController(),
    sessionBusy: new Set(),
    sessionQueues: new Map(),
  };
  ownedSharedServers.add(sharedServer);
  return sharedServer;
}

export async function acquireOpenCodeClient(
  model: string | undefined,
  apiKey: string | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
  abortSignal?: AbortSignal,
  sessionId?: string,
  preparedMcp?: { serverConfig?: Record<string, unknown>; identity?: string; dispose?: () => Promise<void> },
  skillsEnabled = false,
  executionContext?: OpenCodeExecutionContext,
): Promise<AcquiredOpenCodeClient> {
  throwIfAborted(abortSignal);
  throwIfForcedShutdownRequested();
  const key = buildSharedServerKey(model, apiKey, childProcessEnv, preparedMcp?.identity, skillsEnabled);
  const entry = getSharedServerEntry(key);
  const sessionKey = sessionId ?? '';
  const acquireSelectedServer = (server: SharedServer): AcquiredOpenCodeClient | Promise<AcquiredOpenCodeClient> => {
    executionContext?.selectSdk(server.client.sdkState);
    throwIfAborted(abortSignal);
    throwIfForcedShutdownRequested();
    return acquireSharedServer(server, sessionKey, abortSignal);
  };
  if (entry.initPromise !== undefined) {
    const server = await entry.initPromise;
    return acquireSelectedServer(server);
  }
  if (entry.server !== undefined) return acquireSelectedServer(entry.server);

  const initPromise = createSharedServer(key, model, apiKey, childProcessEnv, preparedMcp?.serverConfig, skillsEnabled)
    .then((server) => {
      entry.server = server;
      server.onError((error) => invalidateSharedServer(server, error));
      return server;
    })
    .catch((error: unknown) => {
      recordServerStopFailures(error);
      throw error;
    })
    .finally(() => {
      if (entry.initPromise === initPromise) entry.initPromise = undefined;
      pendingServerInitializations.delete(initPromise);
    });
  entry.initPromise = initPromise;
  pendingServerInitializations.add(initPromise);
  const server = await initPromise;
  return acquireSelectedServer(server);
}

function acquireSharedServer(
  server: SharedServer,
  sessionKey: string,
  abortSignal?: AbortSignal,
): AcquiredOpenCodeClient | Promise<AcquiredOpenCodeClient> {
  throwIfAborted(abortSignal);
  if (server.invalidated) throw sharedServerInvalidationError(server.invalidationController.signal);
  if (!server.sessionBusy.has(sessionKey)) {
    server.sessionBusy.add(sessionKey);
    return createAcquiredClient(server, sessionKey);
  }
  return new Promise((resolve, reject) => {
    const entry: SharedServerQueueEntry = { resolve, reject, signal: abortSignal };
    if (abortSignal !== undefined) {
      entry.onAbort = () => {
        removeQueuedClient(server, sessionKey, entry);
        reject(new Error(OPENCODE_STREAM_ABORTED_MESSAGE));
      };
      abortSignal.addEventListener('abort', entry.onAbort, { once: true });
    }
    const queue = server.sessionQueues.get(sessionKey) ?? [];
    queue.push(entry);
    server.sessionQueues.set(sessionKey, queue);
  });
}

function releaseClient(server: SharedServer, sessionKey: string): void {
  if (server.invalidated) return;
  const queue = server.sessionQueues.get(sessionKey);
  const next = queue?.shift();
  if (next !== undefined) {
    if (next.signal !== undefined && next.onAbort !== undefined) {
      next.signal.removeEventListener('abort', next.onAbort);
    }
    next.resolve(createAcquiredClient(server, sessionKey));
    return;
  }
  if (queue !== undefined) server.sessionQueues.delete(sessionKey);
  server.sessionBusy.delete(sessionKey);
}

function removeQueuedClient(server: SharedServer, sessionKey: string, entry: SharedServerQueueEntry): void {
  const queue = server.sessionQueues.get(sessionKey);
  if (queue !== undefined) {
    const filtered = queue.filter((queued) => queued !== entry);
    if (filtered.length === 0) server.sessionQueues.delete(sessionKey);
    else server.sessionQueues.set(sessionKey, filtered);
  }
  if (entry.signal !== undefined && entry.onAbort !== undefined) {
    entry.signal.removeEventListener('abort', entry.onAbort);
  }
}

function createReleaseHandle(server: SharedServer, sessionKey: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseClient(server, sessionKey);
  };
}

function createAcquiredClient(server: SharedServer, sessionKey: string): AcquiredOpenCodeClient {
  return {
    client: server.client,
    release: createReleaseHandle(server, sessionKey),
    invalidate: (error) => invalidateSharedServer(server, error),
    invalidationSignal: server.invalidationController.signal,
    acquireSession: (nextSessionKey, signal) => acquireSharedServer(server, nextSessionKey, signal),
  };
}

export function sharedServerInvalidationError(signal: AbortSignal): OpenCodeSharedServerInvalidationError {
  return signal.reason instanceof OpenCodeSharedServerInvalidationError
    ? signal.reason
    : new OpenCodeSharedServerInvalidationError(new Error('OpenCode shared server is unavailable'));
}

export function throwIfSharedServerInvalidated(signal: AbortSignal): void {
  if (signal.aborted) throw sharedServerInvalidationError(signal);
}

function invalidateSharedServer(server: SharedServer, error: Error): void {
  if (server.invalidated) return;
  server.invalidated = true;
  if (sharedServers.get(server.key)?.server === server) sharedServers.delete(server.key);
  const queueError = new OpenCodeSharedServerInvalidationError(error);
  server.invalidationController.abort(queueError);
  void server.close().catch(() => undefined);
  for (const queue of server.sessionQueues.values()) {
    for (const queued of queue) {
      if (queued.signal !== undefined && queued.onAbort !== undefined) {
        queued.signal.removeEventListener('abort', queued.onAbort);
      }
      queued.reject(queueError);
    }
  }
  server.sessionQueues.clear();
  server.sessionBusy.clear();
}

export function resetSharedServerPool(): void {
  for (const entry of sharedServers.values()) {
    if (entry.server !== undefined) void entry.server.close().catch(() => undefined);
  }
  sharedServers.clear();
}

export function prepareSharedServerPoolForForcedShutdown(): Promise<void> {
  if (forcedShutdownPromise !== undefined) return forcedShutdownPromise;

  forcedShutdownRequested = true;
  const shutdownPromise = (async () => {
    try {
      await cleanupPendingModelSelectionSessions();
    } catch (error) {
      log.debug('Failed to remove OpenCode model-selection sessions during forced shutdown', {
        error: sanitizeSensitiveText(getErrorMessage(error)),
      });
    }

    resetSharedServerPool();
    await Promise.allSettled([...pendingServerInitializations]);

    const stopResults = await Promise.allSettled(
      [...ownedSharedServers].map((server) => server.close()),
    );
    const stopFailures = [
      ...serverStopFailures,
      ...stopResults.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
    ];
    if (stopFailures.length > 0) {
      throw new AggregateError(stopFailures, 'Failed to confirm that all OpenCode server processes stopped');
    }
  })();
  const sharedShutdownPromise = shutdownPromise.finally(() => {
    if (forcedShutdownPromise === sharedShutdownPromise) forcedShutdownPromise = undefined;
  });
  forcedShutdownPromise = sharedShutdownPromise;
  return sharedShutdownPromise;
}
