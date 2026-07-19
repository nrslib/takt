import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpencode } from '@opencode-ai/sdk/v2';
import { loadTemplate } from '../../shared/prompts/index.js';
import {
  getNestedObservabilityEnvFingerprint,
  runWithNestedObservabilityProcessEnv,
} from '../../shared/telemetry/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { versionAllowsListToolShim } from './list-tool-shim-guard.js';

const OPENCODE_STREAM_ABORTED_MESSAGE = 'OpenCode execution aborted';
const OPENCODE_SERVER_START_TIMEOUT_MS = 60_000;
const TAKT_AGENT = 'takt';
const TAKT_AGENT_REVIEW = 'takt-review';
const TAKT_AGENT_REPORT = 'takt-report';
const log = createLogger('opencode-sdk');

export type OpencodeClient = Awaited<ReturnType<typeof createOpencode>>['client'];

interface SharedServer {
  key: string;
  client: OpencodeClient;
  close: () => void;
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
let opencodeBinaryVersionPromise: Promise<string | undefined> | undefined;

function pluginPath(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'plugins', name);
}

function resolveOpenCodeBinaryVersion(): Promise<string | undefined> {
  opencodeBinaryVersionPromise ??= new Promise((resolvePromise) => {
    execFile('opencode', ['--version'], { timeout: 10_000 }, (error, stdout) => {
      resolvePromise(error ? undefined : String(stdout).trim());
    });
  });
  return opencodeBinaryVersionPromise;
}

async function shouldRegisterListToolShim(): Promise<boolean> {
  const version = await resolveOpenCodeBinaryVersion();
  if (version === undefined) return false;
  const allowed = versionAllowsListToolShim(version);
  log.debug('OpenCode list tool shim decision', { version, allowed });
  return allowed;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error(OPENCODE_STREAM_ABORTED_MESSAGE);
}

function buildSharedServerKey(
  model: string,
  apiKey: string | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): string {
  return JSON.stringify([model, apiKey, getNestedObservabilityEnvFingerprint(childProcessEnv)]);
}

function getSharedServerEntry(key: string): SharedServerEntry {
  const existing = sharedServers.get(key);
  if (existing !== undefined) return existing;
  const entry: SharedServerEntry = {};
  sharedServers.set(key, entry);
  return entry;
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
  model: string,
  apiKey: string | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): Promise<SharedServer> {
  const port = await getFreePort();
  const registerListToolShim = await shouldRegisterListToolShim();
  const { client, server } = await runWithNestedObservabilityProcessEnv(childProcessEnv, () =>
    createOpencode({
      port,
      config: {
        model,
        small_model: model,
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
        },
      },
      timeout: OPENCODE_SERVER_START_TIMEOUT_MS,
    })
  );
  const close = (): void => {
    try {
      server.close();
    } catch (error) {
      log.debug(`Failed to close OpenCode server: ${sanitizeSensitiveText(getErrorMessage(error))}`, { model });
    }
  };
  log.debug('OpenCode server started', { model, port });
  return {
    key,
    client,
    close,
    invalidated: false,
    invalidationController: new AbortController(),
    sessionBusy: new Set(),
    sessionQueues: new Map(),
  };
}

export async function acquireOpenCodeClient(
  model: string,
  apiKey: string | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
  abortSignal?: AbortSignal,
  sessionId?: string,
): Promise<AcquiredOpenCodeClient> {
  throwIfAborted(abortSignal);
  const key = buildSharedServerKey(model, apiKey, childProcessEnv);
  const entry = getSharedServerEntry(key);
  const sessionKey = sessionId ?? '';
  if (entry.initPromise !== undefined) {
    const server = await entry.initPromise;
    throwIfAborted(abortSignal);
    return acquireSharedServer(server, sessionKey, abortSignal);
  }
  if (entry.server !== undefined) return acquireSharedServer(entry.server, sessionKey, abortSignal);

  entry.initPromise = createSharedServer(key, model, apiKey, childProcessEnv)
    .then((server) => {
      entry.server = server;
      return server;
    })
    .finally(() => {
      entry.initPromise = undefined;
    });
  const server = await entry.initPromise;
  throwIfAborted(abortSignal);
  return acquireSharedServer(server, sessionKey, abortSignal);
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
  server.close();
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
  for (const entry of sharedServers.values()) entry.server?.close();
  sharedServers.clear();
}
