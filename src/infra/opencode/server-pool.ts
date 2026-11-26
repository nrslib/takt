import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '@opencode-ai/sdk/v2/types';
import { loadTemplate } from '../../shared/prompts/index.js';
import { getNestedObservabilityEnvFingerprint } from '../../shared/telemetry/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { versionAllowsListToolShim } from './list-tool-shim-guard.js';
import { cleanupPendingModelSelectionSessions } from './model-selection-session-cleanup.js';
import { startOpenCodeServer } from './server-process.js';
import { openCodeRuntimeSelection, resolveOpenCodeRuntime, type OpenCodeRuntime } from './runtime.js';
import { buildV2ServerConfig } from './v2-config.js';
import { buildOpenCodeV1ExternalDirectoryPermissions, normalizeOpenCodeExternalDirectories, normalizeOpenCodeWorkspaceDirectories } from './external-directories.js';
import { parseProviderModel } from '../../shared/utils/providerModel.js';
import type { ManagedOpenCodeTransport, OpenCodeTransport } from './transport.js';
import type { OpenCodeExecutionContext } from './execution-context.js';
import type { OpenCodeWorkspaceAccess } from '../providers/types.js';

const OPENCODE_STREAM_ABORTED_MESSAGE = 'OpenCode execution aborted';
const OPENCODE_SERVER_START_TIMEOUT_MS = 60_000;
const OPENCODE_MODEL_METADATA_TIMEOUT_MS = 10_000;
const TAKT_AGENT = 'takt';
const TAKT_AGENT_REVIEW = 'takt-review';
const TAKT_AGENT_REPORT = 'takt-report';
const TAKT_AGENT_READ = 'takt-read';
const log = createLogger('opencode-sdk');

export type OpencodeClient = OpenCodeTransport;

interface SharedServer {
  entry: SharedServerEntry;
  key: string;
  externalDirectoryAllowlist: readonly string[];
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
  externalDirectoryAllowlist: readonly string[];
  readonlyDirectories: readonly string[];
  workspaceAccess?: OpenCodeWorkspaceAccess;
  pendingAcquisitions: number;
  retirement?: { promise: Promise<void>; resolve(): void; reject(error: unknown): void };
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
const retiringWorkspaceEntries = new Set<SharedServerEntry>();
const workspaceCloseFailures = new Map<string, Set<unknown>>();
const workspaceGenerations = new Map<string, { identity: string }>();
const pendingWorkspaceAcquisitions = new Map<string, Set<Promise<void>>>();
const ownedSharedServers = new Set<SharedServer>();
const pendingServerInitializations = new Set<Promise<SharedServer>>();
const pendingV1ModelProbes = new Set<Promise<number>>();
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
  externalDirectoryAllowlist: readonly string[],
  contextWindow: number | undefined,
  directory: string | undefined,
  outputLimit: number | undefined,
  workspaceAccess: OpenCodeWorkspaceAccess | undefined,
  readonlyDirectories: readonly string[],
): string {
  const runtime = openCodeRuntimeSelection();
  return JSON.stringify([model, apiKey, getNestedObservabilityEnvFingerprint(childProcessEnv), mcpIdentity ?? '', runtime,
    ...(runtime.generation === 'v2' ? [skillsEnabled] : []), externalDirectoryAllowlist, contextWindow,
    ...(runtime.generation === 'v1' && contextWindow !== undefined ? [directory, outputLimit] : []),
    ...(workspaceAccess === undefined ? [] : [workspaceAccess]), readonlyDirectories,
  ]);
}

function getSharedServerEntry(
  key: string,
  externalDirectoryAllowlist: readonly string[],
  workspaceAccess: OpenCodeWorkspaceAccess | undefined,
  readonlyDirectories: readonly string[],
): SharedServerEntry {
  const existing = sharedServers.get(key);
  if (existing !== undefined) return existing;
  const entry: SharedServerEntry = { externalDirectoryAllowlist, workspaceAccess, readonlyDirectories, pendingAcquisitions: 0 };
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

function recordWorkspaceCloseFailure(entry: SharedServerEntry, error: unknown): void {
  const ownerId = entry.workspaceAccess?.ownerId;
  if (ownerId === undefined) return;
  const failures = workspaceCloseFailures.get(ownerId) ?? new Set<unknown>();
  failures.add(error);
  workspaceCloseFailures.set(ownerId, failures);
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

function buildV1ServerConfig(
  runtime: OpenCodeRuntime,
  model: string | undefined,
  apiKey: string | undefined,
  serverConfig: Record<string, unknown> | undefined,
  externalDirectoryAllowlist: readonly string[],
  contextWindow?: number,
  outputLimit?: number,
  workspaceDirectories?: readonly string[],
  readonlyDirectories?: readonly string[],
): Record<string, unknown> {
  const v1ProviderConfig: Record<string, unknown> = {
    ...(apiKey === undefined ? {} : { opencode: { options: { apiKey } } }),
  };
  if (model !== undefined && contextWindow !== undefined) {
    if (outputLimit === undefined) throw new Error('OpenCode v1 output limit is required for a numeric context window');
    const contextModel = parseProviderModel(model, 'OpenCode model');
    const existing = v1ProviderConfig[contextModel.providerID] as Record<string, unknown> | undefined;
    v1ProviderConfig[contextModel.providerID] = {
      ...existing,
      models: { [contextModel.modelID]: { limit: { context: contextWindow, output: outputLimit } } },
    };
  }
  return {
    ...(model === undefined ? {} : { model, small_model: model }),
    plugin: [
      pluginPath('coerce-tool-args.js'),
      ...(versionAllowsListToolShim(runtime.version) ? [pluginPath('list-tool.js')] : []),
    ],
    permission: buildOpenCodeV1ExternalDirectoryPermissions(externalDirectoryAllowlist, workspaceDirectories, readonlyDirectories),
    ...(Object.keys(v1ProviderConfig).length === 0 ? {} : { provider: v1ProviderConfig }),
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
      [TAKT_AGENT_REPORT]: { prompt: loadTemplate('opencode_report_agent_prompt', 'en') },
      [TAKT_AGENT_READ]: {
        prompt: loadTemplate('opencode_read_agent_prompt', 'en'),
        tools: { task: false },
      },
    },
    ...(serverConfig === undefined ? {} : { mcp: serverConfig as NonNullable<Config['mcp']> }),
  };
}

async function probeV1ModelOutputLimit(
  runtime: OpenCodeRuntime,
  model: string,
  directory: string,
  apiKey: string | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
  serverConfig: Record<string, unknown> | undefined,
  externalDirectoryAllowlist: readonly string[],
  abortSignal: AbortSignal | undefined,
): Promise<number> {
  const parsed = parseProviderModel(model, 'OpenCode model');
  abortSignal?.throwIfAborted();
  const probe = await startOpenCodeServer({
    runtime,
    port: await getFreePort(),
    timeoutMs: OPENCODE_SERVER_START_TIMEOUT_MS,
    ...(childProcessEnv === undefined ? {} : { childProcessEnv }),
    config: buildV1ServerConfig(runtime, model, apiKey, serverConfig, externalDirectoryAllowlist),
  });
  let outputLimit: number | undefined;
  let lookupError: unknown;
  try {
    abortSignal?.throwIfAborted();
    if (probe.client.getModelOutputLimit === undefined) throw new Error('OpenCode v1 provider metadata lookup is unavailable');
    const timeoutSignal = AbortSignal.timeout(OPENCODE_MODEL_METADATA_TIMEOUT_MS);
    const requestSignal = AbortSignal.any([
      ...(abortSignal === undefined ? [] : [abortSignal]),
      timeoutSignal,
    ]);
    outputLimit = await new Promise<number>((resolve, reject) => {
      const onAbort = (): void => {
        requestSignal.removeEventListener('abort', onAbort);
        reject(timeoutSignal.aborted
          ? new Error('OpenCode v1 provider metadata lookup timed out', { cause: timeoutSignal.reason })
          : requestSignal.reason);
      };
      if (requestSignal.aborted) {
        onAbort();
        return;
      }
      requestSignal.addEventListener('abort', onAbort, { once: true });
      void Promise.resolve().then(() => {
        requestSignal.throwIfAborted();
        return probe.client.getModelOutputLimit!({ directory, ...parsed }, { signal: requestSignal });
      }).then(
        (value) => { requestSignal.removeEventListener('abort', onAbort); resolve(value); },
        (error: unknown) => { requestSignal.removeEventListener('abort', onAbort); reject(error); },
      );
    });
    abortSignal?.throwIfAborted();
  } catch (error) {
    lookupError = error;
  }
  try {
    await probe.close();
  } catch (closeError) {
    if (lookupError !== undefined) {
      throw new AggregateError([lookupError, closeError], 'OpenCode v1 output lookup and probe shutdown failed');
    }
    throw closeError;
  }
  if (lookupError !== undefined) throw lookupError;
  return outputLimit!;
}

async function createSharedServer(
  key: string,
  model: string | undefined,
  apiKey: string | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
  serverConfig: Record<string, unknown> | undefined,
  skillsEnabled: boolean,
  externalDirectoryAllowlist: readonly string[],
  contextWindow: number | undefined,
  outputLimit: number | undefined,
  entry: SharedServerEntry,
): Promise<SharedServer> {
  const runtime = await resolveOpenCodeRuntime();
  const port = await getFreePort();
  const openCodeServer = await startOpenCodeServer({
    runtime,
    ...(runtime.generation === 'v2' ? { mcpServerNames: Object.keys(serverConfig ?? {}) } : {}),
    port,
    timeoutMs: OPENCODE_SERVER_START_TIMEOUT_MS,
    ...(childProcessEnv === undefined ? {} : { childProcessEnv }),
    config: runtime.generation === 'v2' ? buildV2ServerConfig(
      model, apiKey, pluginPath('v2-session'), serverConfig, skillsEnabled, externalDirectoryAllowlist, contextWindow, entry.workspaceAccess,
      entry.readonlyDirectories,
    ) : buildV1ServerConfig(runtime, model, apiKey, serverConfig, externalDirectoryAllowlist, contextWindow, outputLimit,
      entry.workspaceAccess?.directories, entry.readonlyDirectories),
  });
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
    entry,
    key,
    externalDirectoryAllowlist,
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
  externalDirectoryAllowlist?: readonly string[],
  contextWindow?: number,
  directory?: string,
  workspaceAccess?: OpenCodeWorkspaceAccess,
  readonlyDirectories?: readonly string[],
): Promise<AcquiredOpenCodeClient> {
  throwIfAborted(abortSignal);
  throwIfForcedShutdownRequested();
  const normalizedExternalDirectories = normalizeOpenCodeExternalDirectories(externalDirectoryAllowlist);
  const normalizedReadonlyDirectories = normalizeOpenCodeExternalDirectories(readonlyDirectories);
  const normalizedWorkspace = workspaceAccess === undefined ? undefined : {
    ownerId: workspaceAccess.ownerId, directories: normalizeOpenCodeWorkspaceDirectories(workspaceAccess.directories),
  };
  const generation = normalizedWorkspace === undefined ? undefined : selectWorkspaceGeneration(normalizedWorkspace);
  let completeAcquisition!: () => void;
  const acquisition = new Promise<void>((done) => { completeAcquisition = done; });
  const pending = normalizedWorkspace === undefined ? undefined
    : pendingWorkspaceAcquisitions.get(normalizedWorkspace.ownerId) ?? new Set<Promise<void>>();
  if (normalizedWorkspace !== undefined && pending !== undefined) {
    pending.add(acquisition);
    pendingWorkspaceAcquisitions.set(normalizedWorkspace.ownerId, pending);
  }
  try {
    let outputLimit: number | undefined;
    if (openCodeRuntimeSelection().generation === 'v1' && contextWindow !== undefined) {
      if (model === undefined || directory === undefined) {
        throw new Error('OpenCode v1 numeric context window requires a model and project directory');
      }
      const runtime = await resolveOpenCodeRuntime(abortSignal);
      throwIfForcedShutdownRequested();
      const probePromise = probeV1ModelOutputLimit(
        runtime, model, directory, apiKey, childProcessEnv,
        preparedMcp?.serverConfig, normalizedExternalDirectories, abortSignal,
      ).catch((error: unknown) => {
        recordServerStopFailures(error);
        throw error;
      });
      pendingV1ModelProbes.add(probePromise);
      try {
        outputLimit = await probePromise;
      } finally {
        pendingV1ModelProbes.delete(probePromise);
      }
    }
    throwIfAborted(abortSignal);
    throwIfForcedShutdownRequested();
    const key = buildSharedServerKey(
      model, apiKey, childProcessEnv, preparedMcp?.identity, skillsEnabled,
      normalizedExternalDirectories, contextWindow, directory, outputLimit,
      normalizedWorkspace,
      normalizedReadonlyDirectories,
    );
    const currentGeneration = normalizedWorkspace === undefined || workspaceGenerations.get(normalizedWorkspace.ownerId) === generation;
    const entry: SharedServerEntry = currentGeneration
      ? getSharedServerEntry(key, normalizedExternalDirectories, normalizedWorkspace, normalizedReadonlyDirectories)
      : { externalDirectoryAllowlist: normalizedExternalDirectories, workspaceAccess: normalizedWorkspace,
          readonlyDirectories: normalizedReadonlyDirectories, pendingAcquisitions: 0 } satisfies SharedServerEntry;
    entry.pendingAcquisitions++;
    if (!currentGeneration) void retireSharedServerEntry(key, entry);
    const sessionKey = sessionId ?? '';
    const acquireSelectedServer = (server: SharedServer): AcquiredOpenCodeClient | Promise<AcquiredOpenCodeClient> => {
      executionContext?.selectSdk(server.client.sdkState);
      throwIfAborted(abortSignal);
      throwIfForcedShutdownRequested();
      return acquireSharedServer(server, sessionKey, abortSignal);
    };
    try {
      if (entry.initPromise !== undefined) {
        const server = await entry.initPromise;
        return await acquireSelectedServer(server);
      }
      if (entry.server !== undefined) return await acquireSelectedServer(entry.server);

      const initPromise = createSharedServer(
        key, model, apiKey, childProcessEnv, preparedMcp?.serverConfig, skillsEnabled,
        normalizedExternalDirectories, contextWindow, outputLimit, entry,
      )
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
      return await acquireSelectedServer(server);
    } finally {
      entry.pendingAcquisitions--;
      finishRetiredServer(entry);
    }
  } finally {
    completeAcquisition();
    pending?.delete(acquisition);
    if (normalizedWorkspace !== undefined && pending?.size === 0
      && pendingWorkspaceAcquisitions.get(normalizedWorkspace.ownerId) === pending) {
      pendingWorkspaceAcquisitions.delete(normalizedWorkspace.ownerId);
    }
  }
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
  finishRetiredServer(server.entry);
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
  finishRetiredServer(server.entry);
}

function finishRetiredServer(entry: SharedServerEntry): void {
  if (entry.retirement === undefined || entry.pendingAcquisitions > 0 || entry.initPromise !== undefined) return;
  const server = entry.server;
  if (server !== undefined && (server.sessionBusy.size > 0 || server.sessionQueues.size > 0)) return;
  if (server === undefined) entry.retirement.resolve();
  else void server.close().then(entry.retirement.resolve, entry.retirement.reject);
}

function retireSharedServerEntry(key: string, entry: SharedServerEntry): Promise<void> {
  if (entry.retirement !== undefined) return entry.retirement.promise;
  if (sharedServers.get(key) === entry) sharedServers.delete(key);
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  entry.retirement = { promise, resolve, reject };
  retiringWorkspaceEntries.add(entry);
  void promise.then(
    () => retiringWorkspaceEntries.delete(entry),
    (error: unknown) => {
      retiringWorkspaceEntries.delete(entry);
      recordWorkspaceCloseFailure(entry, error);
    },
  );
  finishRetiredServer(entry);
  return promise;
}

function selectWorkspaceGeneration(access: OpenCodeWorkspaceAccess): { identity: string } {
  const identity = JSON.stringify(access.directories);
  const previous = workspaceGenerations.get(access.ownerId);
  if (previous?.identity === identity) return previous;
  const current = { identity };
  workspaceGenerations.set(access.ownerId, current);
  for (const [key, entry] of sharedServers) {
    if (entry.workspaceAccess?.ownerId === access.ownerId) void retireSharedServerEntry(key, entry);
  }
  return current;
}

export async function closeOpenCodeWorkspaceServers(ownerId: string): Promise<void> {
  workspaceGenerations.delete(ownerId);
  await Promise.all(pendingWorkspaceAcquisitions.get(ownerId) ?? []);
  const closing = new Set<Promise<void>>();
  for (const [key, entry] of sharedServers) {
    if (entry.workspaceAccess?.ownerId === ownerId) closing.add(retireSharedServerEntry(key, entry));
  }
  for (const entry of retiringWorkspaceEntries) {
    if (entry.workspaceAccess?.ownerId === ownerId && entry.retirement !== undefined) closing.add(entry.retirement.promise);
  }
  const results = await Promise.allSettled(closing);
  const failures = new Set(results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
  for (const error of workspaceCloseFailures.get(ownerId) ?? []) failures.add(error);
  workspaceCloseFailures.delete(ownerId);
  if (failures.size > 0) throw new AggregateError([...failures], 'Failed to close OpenCode workspace servers');
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
  finishRetiredServer(server.entry);
}

export function resetSharedServerPool(): void {
  for (const entry of sharedServers.values()) {
    if (entry.server !== undefined) void entry.server.close().catch(() => undefined);
  }
  sharedServers.clear();
  workspaceCloseFailures.clear();
  workspaceGenerations.clear();
}

export async function closeOpenCodeServersForExternalDirectories(
  normalizedDirectories: readonly string[],
): Promise<void> {
  const allowlistIdentity = JSON.stringify(normalizedDirectories);
  if (allowlistIdentity === '[]') return;

  const entries: SharedServerEntry[] = [];
  for (const [key, entry] of sharedServers) {
    if (JSON.stringify(entry.externalDirectoryAllowlist) !== allowlistIdentity) continue;
    sharedServers.delete(key);
    entries.push(entry);
  }
  await Promise.allSettled(entries.flatMap((entry) => entry.initPromise === undefined ? [] : [entry.initPromise]));

  const servers = entries.flatMap((entry) => entry.server === undefined ? [] : [entry.server]);
  const results = await Promise.allSettled(servers.map((server) => server.close()));
  const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to close OpenCode servers for completed run context');
  }
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
    await Promise.allSettled([...pendingV1ModelProbes]);
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
