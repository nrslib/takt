import { parseProviderModel } from '../../shared/utils/providerModel.js';
import type { OpenCodeCompactSessionOptions } from './types.js';
import {
  acquireOpenCodeClient,
  sharedServerInvalidationError,
  throwIfSharedServerInvalidated,
  type AcquiredOpenCodeClient,
  type OpencodeClient,
} from './server-pool.js';

const COMPACTION_TIMEOUT_MS = 3 * 60 * 1000;
const SUMMARY_POLL_INTERVAL_MS = 500;
const ABORTED_MESSAGE = 'OpenCode execution aborted';

interface CompactionDeadline {
  signal: AbortSignal;
  abort(error: Error): void;
  run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  waitForPollInterval(): Promise<void>;
  cleanup(): void;
}

function createCompactionDeadline(externalSignal: AbortSignal | undefined): CompactionDeadline {
  const controller = new AbortController();
  let abortError: Error | undefined;
  let rejectAbort!: (error: Error) => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (error: Error): void => {
    if (abortError !== undefined) return;
    abortError = error;
    controller.abort();
    rejectAbort(error);
  };
  const timeoutId = setTimeout(() => abort(new Error('OpenCode session summarize timed out')), COMPACTION_TIMEOUT_MS);
  const onExternalAbort = (): void => abort(new Error(ABORTED_MESSAGE));
  if (externalSignal?.aborted === true) onExternalAbort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const run = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const operationPromise = Promise.resolve()
      .then(() => operation(controller.signal))
      .catch((error: unknown) => {
        if (abortError !== undefined) return new Promise<never>(() => {});
        throw error;
      });
    return Promise.race([operationPromise, abortPromise]);
  };

  return {
    signal: controller.signal,
    abort,
    run,
    waitForPollInterval: () => run((signal) => new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, SUMMARY_POLL_INTERVAL_MS);
      const onAbort = (): void => {
        clearTimeout(timeoutId);
        signal.removeEventListener('abort', onAbort);
        reject(new Error('OpenCode session summarize timed out'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    })),
    cleanup: () => {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function errorMessage(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const value = error as { message?: unknown; data?: { message?: unknown }; name?: unknown };
  if (typeof value.message === 'string' && value.message.length > 0) return value.message;
  if (typeof value.data?.message === 'string' && value.data.message.length > 0) return value.data.message;
  return typeof value.name === 'string' && value.name.length > 0 ? value.name : undefined;
}

async function collectExistingSummaryIds(
  client: OpencodeClient,
  sessionId: string,
  directory: string,
  deadline: CompactionDeadline,
): Promise<ReadonlySet<string>> {
  const result = await deadline.run((signal) => client.session.messages({ sessionID: sessionId, directory }, { signal }));
  if (result.data === undefined) {
    throw new Error(`OpenCode session messages not readable before summarize: ${sessionId}`);
  }
  const ids = new Set<string>();
  for (const message of result.data) {
    const info = message.info as { id?: string; summary?: boolean } | undefined;
    if (info?.summary !== true) continue;
    if (typeof info.id !== 'string') throw new Error(`OpenCode summary message has no id: ${sessionId}`);
    ids.add(info.id);
  }
  return ids;
}

async function waitForSummary(
  client: OpencodeClient,
  sessionId: string,
  directory: string,
  existingIds: ReadonlySet<string>,
  deadline: CompactionDeadline,
): Promise<void> {
  while (true) {
    const result = await deadline.run((signal) => client.session.messages({ sessionID: sessionId, directory }, { signal }));
    if (result.data === undefined) {
      throw new Error(`OpenCode session messages not readable while waiting for summary: ${sessionId}`);
    }
    const summary = [...result.data].reverse().find((message) => {
      const info = message.info as { id?: string; summary?: boolean } | undefined;
      if (info?.summary !== true) return false;
      if (typeof info.id !== 'string') throw new Error(`OpenCode summary message has no id: ${sessionId}`);
      return !existingIds.has(info.id);
    });
    if (summary === undefined) {
      await deadline.waitForPollInterval();
      continue;
    }
    const info = summary.info as { error?: unknown; time?: { completed?: number } };
    if (info.error !== undefined) {
      throw new Error(`OpenCode session summarize failed: ${errorMessage(info.error) ?? 'unknown error'}`);
    }
    if (info.time?.completed !== undefined) return;
    await deadline.waitForPollInterval();
  }
}

export async function compactOpenCodeSessionWithCoordinator(options: OpenCodeCompactSessionOptions): Promise<void> {
  const parsedModel = parseProviderModel(options.model, 'OpenCode model');
  const fullModel = `${parsedModel.providerID}/${parsedModel.modelID}`;
  const deadline = createCompactionDeadline(options.abortSignal);
  let acquired: AcquiredOpenCodeClient | undefined;
  let removeInvalidationListener: (() => void) | undefined;
  try {
    const client = await deadline.run(() => acquireOpenCodeClient(
      fullModel,
      options.opencodeApiKey,
      options.childProcessEnv,
      deadline.signal,
      options.sessionId,
    ));
    acquired = client;
    const onInvalidated = (): void => deadline.abort(sharedServerInvalidationError(client.invalidationSignal));
    if (client.invalidationSignal.aborted) onInvalidated();
    else {
      client.invalidationSignal.addEventListener('abort', onInvalidated, { once: true });
      removeInvalidationListener = () => client.invalidationSignal.removeEventListener('abort', onInvalidated);
    }
    throwIfSharedServerInvalidated(client.invalidationSignal);
    const existingIds = await collectExistingSummaryIds(client.client, options.sessionId, options.cwd, deadline);
    await deadline.run((signal) => client.client.session.summarize({
      sessionID: options.sessionId,
      directory: options.cwd,
      providerID: parsedModel.providerID,
      modelID: parsedModel.modelID,
      auto: false,
    }, { signal }));
    await waitForSummary(client.client, options.sessionId, options.cwd, existingIds, deadline);
    throwIfSharedServerInvalidated(client.invalidationSignal);
  } finally {
    removeInvalidationListener?.();
    acquired?.release();
    deadline.cleanup();
  }
}
