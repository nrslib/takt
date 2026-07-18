/**
 * OpenCode SDK integration for agent interactions
 *
 * Uses @opencode-ai/sdk/v2 for native TypeScript integration.
 * Follows the same patterns as the Codex client.
 */

import { createOpencode } from '@opencode-ai/sdk/v2';
import { createServer } from 'node:net';
import type { AgentResponse } from '../../core/models/index.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import { mapsToOpenCodeEditPermission } from './allowedTools.js';
import { AskUserQuestionDeniedError } from '../../core/workflow/ask-user-question-error.js';
import { parseLastJsonBlock } from '../../agents/structured-caller/shared.js';
import { createLogger, getErrorMessage, createStreamDiagnostics, type StreamDiagnostics } from '../../shared/utils/index.js';
import {
  getNestedObservabilityEnvFingerprint,
  runWithNestedObservabilityProcessEnv,
} from '../../shared/telemetry/index.js';
import { parseProviderModel } from '../../shared/utils/providerModel.js';
import {
  buildOpenCodePermissionRuleset,
  buildOpenCodePromptTools,
  buildOpenCodeSessionPermission,
  resolveOpenCodePermissionReply,
  type OpenCodeCompactSessionOptions,
  type OpenCodeCallOptions,
} from './types.js';
import {
  type OpenCodeStreamEvent,
  type OpenCodePart,
  type OpenCodeTextPart,
  type OpenCodeToolPart,
  createStreamTrackingState,
  emitInit,
  emitText,
  emitPermissionAsked,
  emitPermissionSummary,
  emitResult,
  handlePartUpdated,
} from './OpenCodeStreamHandler.js';
import { InvalidToolArgumentLoopDetector, ToolErrorBudgetDetector, UnavailableToolLoopDetector } from './unavailable-tool-loop.js';
import { buildRateLimitedResponseFields, containsRateLimitError } from '../rate-limit/detection.js';

export type { OpenCodeCallOptions } from './types.js';

const TAKT_AGENT = 'takt';
const TAKT_AGENT_REVIEW = 'takt-review';
const TAKT_AGENT_REPORT = 'takt-report';

/**
 * イベントが属するセッション ID を取り出す。イベントバスはサーバ全体で
 * 共有されるため、無音検出のリセットは「自セッションの進捗」だけに
 * 反応させる必要がある（LSP・ファイルウォッチャ・兄弟セッションの
 * イベントでリセットすると、生成が死んでいても永遠にハングする）。
 */
function extractEventSessionId(event: OpenCodeStreamEvent): string | undefined {
  const props = event.properties as Record<string, unknown> | undefined;
  if (!props) return undefined;
  if (typeof props.sessionID === 'string') return props.sessionID;
  const part = props.part as { sessionID?: unknown } | undefined;
  if (part !== undefined && typeof part.sessionID === 'string') return part.sessionID;
  const info = props.info as { sessionID?: unknown } | undefined;
  if (info !== undefined && typeof info.sessionID === 'string') return info.sessionID;
  return undefined;
}

function selectTaktAgent(allowedTools: readonly string[] | undefined): string {
  if (allowedTools !== undefined && allowedTools.length === 0) {
    return TAKT_AGENT_REPORT;
  }
  const hasBash = allowedTools === undefined
    || allowedTools.some((t) => t.trim().toLowerCase() === 'bash');
  const hasEdit = allowedTools === undefined
    || allowedTools.some((t) => mapsToOpenCodeEditPermission(t));
  if (hasEdit && hasBash) {
    return TAKT_AGENT;
  }
  return TAKT_AGENT_REVIEW;
}

const log = createLogger('opencode-sdk');
/** 呼び出し時に評価する（テストや実験で env から上書きできるようにする） */
function resolveMessageCycleBudget(): number {
  const fromEnv = Number(process.env.TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET);
  return fromEnv > 0 ? fromEnv : 120;
}

/** 呼び出し時に評価する（テストや実験で env から上書きできるようにする） */
function resolveStreamIdleTimeoutMs(): number {
  const fromEnv = Number(process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS);
  return fromEnv > 0 ? fromEnv : 10 * 60 * 1000;
}
const OPENCODE_STREAM_ABORTED_MESSAGE = 'OpenCode execution aborted';
const OPENCODE_RETRY_MAX_ATTEMPTS = 3;
const OPENCODE_RETRY_BASE_DELAY_MS = 250;
const OPENCODE_INTERACTION_TIMEOUT_MS = 5000;
const OPENCODE_SERVER_START_TIMEOUT_MS = 60000;
const OPENCODE_RETRYABLE_ERROR_PATTERNS = [
  'stream disconnected before completion',
  'transport error',
  'network error',
  'error decoding response body',
  'econnreset',
  'etimedout',
  'eai_again',
  'fetch failed',
  'failed to start server on port',
  'timeout waiting for server',
];
type OpencodeClient = Awaited<ReturnType<typeof createOpencode>>['client'];
type OpenCodeSessionSnapshot = NonNullable<Awaited<ReturnType<OpencodeClient['session']['get']>>['data']>;
type OpenCodeAbortCause = 'timeout' | 'external' | 'prompt';

interface SharedServer {
  client: OpencodeClient;
  close: () => void;
  model: string;
  apiKey?: string;
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

interface AcquiredOpenCodeClient {
  client: OpencodeClient;
  release: () => void;
}

let nextProvisionalId = 1;

const sharedServers = new Map<string, SharedServerEntry>();
let exitCleanupRegistered = false;

function registerSharedServerExitCleanup(): void {
  if (exitCleanupRegistered) {
    return;
  }
  process.once('exit', resetSharedServer);
  exitCleanupRegistered = true;
}

async function acquireClient(
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

  if (entry.initPromise) {
    const server = await entry.initPromise;
    throwIfAborted(abortSignal);
    return acquireSharedServer(server, sessionKey, abortSignal);
  }

  if (entry.server) {
    return acquireSharedServer(entry.server, sessionKey, abortSignal);
  }

  entry.initPromise = createSharedServer(model, apiKey, childProcessEnv)
    .then((server) => {
      entry.server = server;
      registerSharedServerExitCleanup();
      return server;
    })
    .finally(() => {
      entry.initPromise = undefined;
    });

  const server = await entry.initPromise;
  throwIfAborted(abortSignal);
  return acquireSharedServer(server, sessionKey, abortSignal);
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
  if (existing) {
    return existing;
  }

  const entry: SharedServerEntry = {};
  sharedServers.set(key, entry);
  return entry;
}

async function createSharedServer(
  model: string,
  apiKey: string | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): Promise<SharedServer> {
  const port = await getFreePort();
  const { client, server } = await runWithNestedObservabilityProcessEnv(childProcessEnv, () =>
    createOpencode({
      port,
      config: {
        model,
        small_model: model,
        // Session-level permission rules are rewritten whenever a prompt
        // carries a tools map (OpenCode materializes the map into
        // session.permission), so session-scoped denies do not survive the
        // first prompt. Server-config permission is outside that rewrite and
        // is the only layer that reliably keeps out-of-workspace access a
        // soft tool error instead of an ask (which would depend on the
        // user's global OpenCode config).
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
  log.debug('OpenCode server started with TAKT agents', {
    agents: [TAKT_AGENT, TAKT_AGENT_REVIEW, TAKT_AGENT_REPORT],
    model,
    port,
  });

  const closeServer = (): void => {
    try {
      server.close();
    } catch (error) {
      log.debug(`Failed to close OpenCode server: ${getErrorMessage(error)}`, { model });
    }
  };

  log.debug('OpenCode server started', { model, port });
  return { client, close: closeServer, model, apiKey, sessionBusy: new Set(), sessionQueues: new Map() };
}

function acquireSharedServer(
  server: SharedServer,
  sessionKey: string,
  abortSignal?: AbortSignal,
): AcquiredOpenCodeClient | Promise<AcquiredOpenCodeClient> {
  throwIfAborted(abortSignal);
  if (!server.sessionBusy.has(sessionKey)) {
    server.sessionBusy.add(sessionKey);
    return { client: server.client, release: createReleaseHandle(server, sessionKey) };
  }

  return new Promise((resolve, reject) => {
    const entry: SharedServerQueueEntry = { resolve, reject, signal: abortSignal };
    if (abortSignal) {
      entry.onAbort = () => {
        removeQueuedClient(server, sessionKey, entry);
        reject(new Error(OPENCODE_STREAM_ABORTED_MESSAGE));
      };
      abortSignal.addEventListener('abort', entry.onAbort, { once: true });
    }
    let queue = server.sessionQueues.get(sessionKey);
    if (!queue) {
      queue = [];
      server.sessionQueues.set(sessionKey, queue);
    }
    queue.push(entry);
  });
}

export async function getOpenCodeSessionSnapshot(
  model: string,
  sessionID: string,
  directory: string,
  apiKey?: string,
): Promise<OpenCodeSessionSnapshot> {
  const { client, release } = await acquireClient(model, apiKey, undefined, undefined, sessionID);
  try {
    const result = await client.session.get({ sessionID, directory });
    if (!result.data) {
      throw new Error(`OpenCode session not found: ${sessionID}`);
    }
    return result.data;
  } finally {
    release();
  }
}

export type OpenCodeSessionMessages = NonNullable<Awaited<ReturnType<OpencodeClient['session']['messages']>>['data']>;

/** レート制限を示す HTTP ステータス。プロバイダは 429 を返す。 */
const RATE_LIMIT_STATUS_CODE = 429;

/**
 * 検死 RPC の上限。検死自体がハングして再度の無限待ちを招かないようにする。
 * 呼び出し時に評価する（テストで env から上書きできるようにする）。
 */
function resolvePostmortemTimeoutMs(): number {
  const fromEnv = Number(process.env.TAKT_OPENCODE_POSTMORTEM_TIMEOUT_MS);
  return fromEnv > 0 ? fromEnv : 5000;
}

/** statusCode は数値でも文字列でも来うるため正規化する。 */
function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const data = (error as { data?: { statusCode?: unknown } }).data;
  const raw = data?.statusCode;
  if (typeof raw === 'number') {
    return raw;
  }
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * 直近の assistant メッセージのエラーを検死し、レート制限ならその内容を返す。
 *
 * OpenCode サーバはプロバイダの 429 を内部リトライで握り、イベントバスへ
 * session.error を流さない。takt からは「無音のまま停止したセッション」に
 * 見えるため、無音ウォッチドッグのタイムアウト後にここで死因を確かめる。
 *
 * 判定するのは「最新の assistant メッセージ」だけに限る。sessionId は phase や
 * resume で再利用されるため、過去の assistant に残る古い 429 を今回の死因と
 * 誤認しないようにする。
 */
async function postmortemRateLimitError(
  client: OpencodeClient,
  sessionID: string,
  directory: string,
): Promise<string | undefined> {
  let messages: OpenCodeSessionMessages;
  try {
    const result = await withTimeout(
      (signal) => client.session.messages({ sessionID, directory }, { signal }),
      resolvePostmortemTimeoutMs(),
      'OpenCode rate limit postmortem timed out',
    );
    if (!result.data) {
      return undefined;
    }
    messages = result.data;
  } catch (error) {
    // 検死そのものの失敗（RPC エラー・ハング）で本来のエラーを覆い隠さない。
    log.debug('Rate limit postmortem could not read session messages', {
      sessionID,
      error: getErrorMessage(error),
    });
    return undefined;
  }

  // 末尾が assistant でないなら、今回のターンの応答はまだ作られていない。
  // ここで過去へ遡ると、セッション再利用時に前回ターンの 429 を今回の死因と
  // 誤認する（[前回 assistant 429, 今回 user prompt] のまま無音停止する形）。
  const latestInfo = messages[messages.length - 1]?.info;
  if (latestInfo?.role !== 'assistant') {
    return undefined;
  }
  const error = latestInfo.error;
  if (error === undefined) {
    return undefined;
  }
  const message = extractOpenCodeErrorMessage(error);
  if (extractStatusCode(error) === RATE_LIMIT_STATUS_CODE) {
    return message ?? `HTTP ${RATE_LIMIT_STATUS_CODE} Too Many Requests`;
  }
  if (message !== undefined && containsRateLimitError(message)) {
    return message;
  }
  return undefined;
}

export async function getOpenCodeSessionMessages(
  model: string,
  sessionID: string,
  directory: string,
  apiKey?: string,
): Promise<OpenCodeSessionMessages> {
  const { client, release } = await acquireClient(model, apiKey, undefined, undefined, sessionID);
  try {
    const result = await client.session.messages({ sessionID, directory });
    if (!result.data) {
      throw new Error(`OpenCode session messages not found: ${sessionID}`);
    }
    return result.data;
  } finally {
    release();
  }
}

function releaseClient(server: SharedServer, sessionKey: string): void {
  const queue = server.sessionQueues.get(sessionKey);
  const next = queue?.shift();
  if (next) {
    if (next.signal && next.onAbort) {
      next.signal.removeEventListener('abort', next.onAbort);
    }
    next.resolve({ client: server.client, release: createReleaseHandle(server, sessionKey) });
    return;
  }
  if (queue !== undefined) {
    server.sessionQueues.delete(sessionKey);
  }
  server.sessionBusy.delete(sessionKey);
}

function removeQueuedClient(server: SharedServer, sessionKey: string, entry: SharedServerQueueEntry): void {
  const queue = server.sessionQueues.get(sessionKey);
  if (queue) {
    const filtered = queue.filter((queued) => queued !== entry);
    if (filtered.length === 0) {
      server.sessionQueues.delete(sessionKey);
    } else {
      server.sessionQueues.set(sessionKey, filtered);
    }
  }
  if (entry.signal && entry.onAbort) {
    entry.signal.removeEventListener('abort', entry.onAbort);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error(OPENCODE_STREAM_ABORTED_MESSAGE);
  }
}

function createExternalAbortPromise(
  controller: AbortController,
  externalAbortSignal: AbortSignal | undefined,
): { promise?: Promise<never>; removeListener?: () => void } {
  if (externalAbortSignal === undefined) {
    return {};
  }
  let removeListener: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    const onExternalAbort = (): void => {
      reject(new Error(OPENCODE_STREAM_ABORTED_MESSAGE));
      controller.abort();
    };
    if (externalAbortSignal.aborted) {
      onExternalAbort();
      return;
    }
    externalAbortSignal.addEventListener('abort', onExternalAbort, { once: true });
    removeListener = () => externalAbortSignal.removeEventListener('abort', onExternalAbort);
  });
  return { promise, removeListener };
}

function createReleaseHandle(server: SharedServer, sessionKey: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseClient(server, sessionKey);
  };
}

export function resetSharedServer(): void {
  for (const entry of sharedServers.values()) {
    entry.server?.close();
  }
  sharedServers.clear();
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutErrorMessage: string,
  externalAbortSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(timeoutErrorMessage));
    }, timeoutMs);
  });
  const externalAbort = createExternalAbortPromise(controller, externalAbortSignal);
  try {
    const operationPromise = operation(controller.signal).catch((error: unknown) => {
      if (timedOut) {
        return new Promise<never>(() => {
          // The timeout promise owns the rejection after aborting the SDK call.
        });
      }
      throw error;
    });
    const racePromises = externalAbort.promise !== undefined
      ? [operationPromise, timeoutPromise, externalAbort.promise]
      : [operationPromise, timeoutPromise];
    return await Promise.race(racePromises);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    externalAbort.removeListener?.();
  }
}

function extractOpenCodeErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const value = error as { message?: unknown; data?: { message?: unknown }; name?: unknown };
  if (typeof value.message === 'string' && value.message.length > 0) {
    return value.message;
  }
  if (typeof value.data?.message === 'string' && value.data.message.length > 0) {
    return value.data.message;
  }
  if (typeof value.name === 'string' && value.name.length > 0) {
    return value.name;
  }
  return undefined;
}

function stripPromptEcho(
  chunk: string,
  echoState: { remainingPrompts: string[] },
): string {
  if (!chunk) return '';
  if (echoState.remainingPrompts.length === 0) return chunk;

  const matchingPrompts = echoState.remainingPrompts.filter((remainingPrompt) => (
    remainingPrompt.startsWith(chunk) || chunk.startsWith(remainingPrompt)
  ));
  if (matchingPrompts.length === 0) {
    echoState.remainingPrompts = [];
    return chunk;
  }

  const consumedPrompt = matchingPrompts
    .filter((remainingPrompt) => chunk.startsWith(remainingPrompt))
    .sort((a, b) => b.length - a.length)[0];
  if (consumedPrompt !== undefined) {
    const visible = chunk.slice(consumedPrompt.length);
    echoState.remainingPrompts = [];
    return visible;
  }

  echoState.remainingPrompts = matchingPrompts.map((remainingPrompt) => (
    remainingPrompt.slice(chunk.length)
  ));
  return '';
}

function buildPromptEchoCandidates(prompt: string, systemPrompt: string | undefined): string[] {
  const prompts = [prompt];
  if (systemPrompt !== undefined && systemPrompt.length > 0) {
    prompts.unshift(`${systemPrompt}\n\n${prompt}`);
  }

  return Array.from(new Set(prompts)).filter((candidate) => candidate.length > 0);
}

type OpenCodeQuestionOption = {
  label: string;
  description: string;
};

type OpenCodeQuestionInfo = {
  question: string;
  header: string;
  options: OpenCodeQuestionOption[];
  multiple?: boolean;
};

type OpenCodeQuestionAskedProperties = {
  id: string;
  sessionID: string;
  questions: OpenCodeQuestionInfo[];
};

function toQuestionInput(props: OpenCodeQuestionAskedProperties): {
  questions: Array<{
    question: string;
    header?: string;
    options?: Array<{
      label: string;
      description?: string;
    }>;
    multiSelect?: boolean;
  }>;
} {
  return {
    questions: props.questions.map((item) => ({
      question: item.question,
      header: item.header,
      options: item.options.map((opt) => ({
        label: opt.label,
        description: opt.description,
      })),
      multiSelect: item.multiple,
    })),
  };
}

function toQuestionAnswers(
  props: OpenCodeQuestionAskedProperties,
  answers: Record<string, string>,
): Array<Array<string>> {
  return props.questions.map((item) => {
    const key = item.header || item.question;
    const value = answers[key];
    if (!value) return [];
    return [value];
  });
}

function buildPermissionRejectedMessage(permission: string | undefined): string {
  if (permission && permission.length > 0) {
    return `OpenCode permission rejected: ${permission}`;
  }
  return 'OpenCode permission rejected';
}

async function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to allocate free TCP port')));
        return;
      }
      const port = addr.port;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

/**
 * Client for OpenCode SDK agent interactions.
 *
 * Handles session management, streaming event conversion,
 * permission auto-reply, and response processing.
 */
export class OpenCodeClient {
  private isRetriableError(message: string, aborted: boolean, abortCause?: OpenCodeAbortCause): boolean {
    if (abortCause === 'timeout') {
      return true;
    }

    if (abortCause === 'prompt') {
      const lower = message.toLowerCase();
      return OPENCODE_RETRYABLE_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
    }

    if (aborted || abortCause) {
      return false;
    }

    const lower = message.toLowerCase();
    return OPENCODE_RETRYABLE_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
  }

  private async waitForRetryDelay(
    attempt: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const delayMs = OPENCODE_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1));
    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        resolve();
      }, delayMs);

      const onAbort = (): void => {
        clearTimeout(timeoutId);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        reject(new Error(OPENCODE_STREAM_ABORTED_MESSAGE));
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  private buildRateLimitedResponse(
    agentType: string,
    sessionId: string | undefined,
    message: string,
  ): AgentResponse {
    return {
      persona: agentType,
      timestamp: new Date(),
      sessionId,
      ...buildRateLimitedResponseFields('opencode', 'sdk_error', message),
    };
  }

  /** Call OpenCode with an agent prompt */
  async call(
    agentType: string,
    prompt: string,
    options: OpenCodeCallOptions,
  ): Promise<AgentResponse> {
    // native format（StructuredOutput ツール）をモデルが呼ばない個体が
    // あるため、その失敗を検出したら format なし（手書き JSON + 下流の
    // 是正リトライ）へフォールバックする。
    let disableNativeStructuredOutput = false;
    // フォールバック（format なし再試行）は transient 再試行の予算とは別枠で
    // 1回だけ確保する: 先行の transient エラーで予算を使い切っていても、
    // 最終試行の format 失敗から救済できるようにする。
    let maxAttempts = OPENCODE_RETRY_MAX_ATTEMPTS;
    const provisionalKey = options.sessionId === undefined
      ? `provisional-${nextProvisionalId++}`
      : undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let idleTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const streamAbortController = new AbortController();
      const streamIdleTimeoutMs = resolveStreamIdleTimeoutMs();
      const timeoutMessage = `OpenCode stream timed out after ${Math.round(streamIdleTimeoutMs / 60000)} minutes of inactivity`;
      let abortCause: OpenCodeAbortCause | undefined;
      let diagRef: StreamDiagnostics | undefined;
      let release: (() => void) | undefined;
      let opencodeApiClient: OpencodeClient | undefined;
      let sessionId: string | undefined = options.sessionId;
      let promptCompletion: Promise<unknown> | undefined;
      let promptCompletionWait: Promise<void> | undefined;
      let promptError: string | undefined;
      const interactionTimeoutMs = options.interactionTimeoutMs ?? OPENCODE_INTERACTION_TIMEOUT_MS;
      const promptCompletionTimeoutMessage = 'OpenCode prompt completion timed out';

      const awaitPromptCompletion = (): Promise<void> => {
        if (!promptCompletion) {
          return Promise.resolve();
        }

        promptCompletionWait ??= (async () => {
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              promptCompletion,
              new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => {
                  reject(new Error(promptCompletionTimeoutMessage));
                }, interactionTimeoutMs);
              }),
            ]);
          } catch (error) {
            promptError ??= getErrorMessage(error);
          } finally {
            if (timeoutId !== undefined) {
              clearTimeout(timeoutId);
            }
          }
        })();
        return promptCompletionWait;
      };

      const resetIdleTimeout = (): void => {
        if (idleTimeoutId !== undefined) {
          clearTimeout(idleTimeoutId);
        }
        idleTimeoutId = setTimeout(() => {
          diagRef?.onIdleTimeoutFired();
          log.warn(timeoutMessage, { sessionId, model: options.model });
          abortCause = 'timeout';
          streamAbortController.abort();
        }, streamIdleTimeoutMs);
      };

      const onExternalAbort = (): void => {
        abortCause = 'external';
        streamAbortController.abort();
      };

      if (options.abortSignal) {
        if (options.abortSignal.aborted) {
          abortCause = 'external';
          streamAbortController.abort();
        } else {
          options.abortSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
      }

      try {
        log.debug('Starting OpenCode session', {
          agentType,
          model: options.model,
          hasSystemPrompt: !!options.systemPrompt,
          attempt,
        });

        const diag = createStreamDiagnostics('opencode-sdk', { agentType, model: options.model, attempt });
        diagRef = diag;

        const parsedModel = parseProviderModel(options.model, 'OpenCode model');
        const fullModel = `${parsedModel.providerID}/${parsedModel.modelID}`;

        const acquired = await acquireClient(
          fullModel,
          options.opencodeApiKey,
          options.childProcessEnv,
          options.abortSignal,
          sessionId ?? provisionalKey,
        );
        opencodeApiClient = acquired.client;
        release = acquired.release;
        if (streamAbortController.signal.aborted) {
          release();
          release = undefined;
          throw new Error(OPENCODE_STREAM_ABORTED_MESSAGE);
        }
        const permissionRuleset = buildOpenCodePermissionRuleset(
          options.permissionMode,
          options.networkAccess,
          options.allowedTools,
        );
        // The session is created once per step and reused across phases: a
        // session-scoped deny can never be escalated later, and recreating the
        // session drops the conversation history the report/judgment phases
        // depend on. Per-phase tool restriction rides on the explicit prompt
        // tools map below instead.
        const appliedPermissionRuleset = sessionId === undefined;
        const sessionPermission = buildOpenCodeSessionPermission(
          options.permissionMode,
          options.networkAccess,
          options.allowedTools,
        );
        if (sessionId === undefined) {
          const sessionResult = await opencodeApiClient.session.create({
            directory: options.cwd,
            permission: sessionPermission,
          });

          sessionId = sessionResult.data?.id;
          if (!sessionId) {
            throw new Error('Failed to create OpenCode session');
          }

          if (provisionalKey !== undefined) {
            const realAcquired = await acquireClient(
              fullModel,
              options.opencodeApiKey,
              options.childProcessEnv,
              options.abortSignal,
              sessionId,
            );
            release!();
            release = realAcquired.release;
          }
        }

        const activeSessionId = sessionId;
        if (activeSessionId === undefined) {
          throw new Error('OpenCode session ID is required');
        }

        const { stream } = await opencodeApiClient.event.subscribe(
          { directory: options.cwd },
          { signal: streamAbortController.signal },
        );
        resetIdleTimeout();
        diag.onConnected();
        if (appliedPermissionRuleset) {
          emitPermissionSummary(options.onStream, {
            sessionId: activeSessionId,
            ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
            ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
            ...(options.networkAccess !== undefined ? { networkAccess: options.networkAccess } : {}),
            resolvedPermissions: sessionPermission,
          });
        }

        const agentName = selectTaktAgent(options.allowedTools);
        // OpenCode persists the last explicit tools map on the session, so
        // every prompt sends the full map for its own phase (see
        // buildOpenCodePromptTools).
        const promptTools = buildOpenCodePromptTools(
          options.permissionMode,
          options.networkAccess,
          options.allowedTools,
        );
        log.debug('Selecting OpenCode agent', {
          agentName,
          allowedTools: options.allowedTools,
          promptTools,
        });
        const promptPayload: Record<string, unknown> = {
          sessionID: activeSessionId,
          directory: options.cwd,
          model: parsedModel,
          tools: promptTools,
          ...(agentName !== undefined ? { agent: agentName } : {}),
          ...(options.variant !== undefined ? { variant: options.variant } : {}),
          ...(options.systemPrompt !== undefined ? { system: options.systemPrompt } : {}),
          // ネイティブ構造化出力: OpenCode がスキーマのキー構造を強制する
          // （enum 等の値制約までは保証されないため、下流のスキーマ検証は維持）。
          ...(options.outputSchema !== undefined && !disableNativeStructuredOutput
            ? { format: { type: 'json_schema' as const, schema: options.outputSchema, retryCount: 2 } }
            : {}),
          parts: [{ type: 'text' as const, text: prompt }],
        };
        const promptPayloadForSdk = promptPayload as unknown as Parameters<typeof opencodeApiClient.session.promptAsync>[0];
        promptCompletion = opencodeApiClient.session.promptAsync(promptPayloadForSdk, {
          signal: streamAbortController.signal,
        }).catch((error) => {
          promptError = getErrorMessage(error);
          if (!streamAbortController.signal.aborted) {
            abortCause = 'prompt';
            streamAbortController.abort();
          }
        });

        emitInit(options.onStream, options.model, activeSessionId);

        let content = '';
        let success = true;
        let capturedStructuredOutput: Record<string, unknown> | undefined;
        let failureMessage = '';
        const state = createStreamTrackingState();
        const unavailableToolLoopDetector = new UnavailableToolLoopDetector();
        const invalidArgumentLoopDetector = new InvalidToolArgumentLoopDetector();
        const toolErrorBudgetDetector = new ToolErrorBudgetDetector();
        const echoState = { remainingPrompts: buildPromptEchoCandidates(prompt, options.systemPrompt) };
        const textOffsets = new Map<string, number>();
        const textContentParts = new Map<string, string>();

        // Consume a raw text delta for a part: strip the prompt echo, stream the
        // visible portion, accumulate it, and advance the part's raw offset in
        // lockstep. Sharing this keeps content and offset consistent whether the
        // text arrives via `message.part.delta` or a full-snapshot
        // `message.part.updated` — some providers emit both for the same part.
        const consumeTextDelta = (partId: string, rawDelta: string): void => {
          if (!rawDelta) return;
          const visibleDelta = stripPromptEcho(rawDelta, echoState);
          if (visibleDelta) {
            emitText(options.onStream, visibleDelta);
            const previous = textContentParts.get(partId) ?? '';
            textContentParts.set(partId, `${previous}${visibleDelta}`);
          }
          const prevOffset = textOffsets.get(partId) ?? 0;
          textOffsets.set(partId, prevOffset + rawDelta.length);
        };

        // for-await 単体だと、タイマーが abort してもイベントが来るまで
        // 待ちから戻らない（SDK が signal を尊重しない場合は永久待機）。
        // イテレータと abort をレースさせ、タイマー発火で必ず脱出する。
        const streamIterator = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        const streamAborted = new Promise<never>((_, reject) => {
          streamAbortController.signal.addEventListener('abort', () => {
            reject(new Error(timeoutMessage));
          }, { once: true });
        });
        streamAborted.catch(() => { /* race の敗者側での未処理拒否を防ぐ */ });

        // 劣化した生成は「ごく短いアシスタント応答サイクル」を数百回繰り返す
        // （実測: 524〜1211 ループ）。テキスト断片だけの空転はツールエラー
        // 予算にも無音検出にも掛からないため、応答サイクル数で打ち切る。
        // 健全なステップはツール往復込みでも数十サイクルに収まる。
        let assistantMessageCycles = 0;
        const messageCycleBudget = resolveMessageCycleBudget();

        try {
        while (true) {
          if (streamAbortController.signal.aborted) break;
          let iteration: IteratorResult<unknown>;
          try {
            iteration = await Promise.race([streamIterator.next(), streamAborted]);
          } catch (raceError) {
            if (streamAbortController.signal.aborted) break;
            throw raceError;
          }
          if (iteration.done) break;
          const event = iteration.value;

          const sseEvent = event as OpenCodeStreamEvent;
          // セッション帰属が判明していて自分でないイベントは処理しない。
          // サーバプールは同一モデルで共有されるため（並列レビュー等）、
          // 兄弟セッションの text/tool 更新を通すと content と検出器が
          // 汚染される。帰属不明のイベントは種別ごとの処理に委ねるが、
          // 無音検出のリセット（延命）は自セッションのイベントに限る。
          const eventSessionId = extractEventSessionId(sseEvent);
          if (eventSessionId !== undefined && eventSessionId !== activeSessionId) {
            continue;
          }
          if (eventSessionId === activeSessionId) {
            resetIdleTimeout();
          }
          diag.onFirstEvent(sseEvent.type);
          diag.onEvent(sseEvent.type);
          if (sseEvent.type === 'message.part.updated') {
            const props = sseEvent.properties as { part: OpenCodePart; delta?: string };
            const part = props.part;
            const delta = props.delta;

            if (part.type === 'text') {
              unavailableToolLoopDetector.reset();
              const textPart = part as OpenCodeTextPart;
              const prev = textOffsets.get(textPart.id) ?? 0;
              const rawDelta = delta
                ?? (textPart.text.length > prev ? textPart.text.slice(prev) : '');
              consumeTextDelta(textPart.id, rawDelta);
              continue;
            }

            if (part.type === 'tool') {
              const toolPart = part as OpenCodeToolPart;
              let loopError: string | undefined;
              if (toolPart.state.status === 'error') {
                // 両検出器に必ず観測させる（?? 短絡だと invalid 側が
                // unavailable エラーを見逃し、連続性の判定が狂う）
                const unavailableError = unavailableToolLoopDetector.observe(
                  toolPart.callID || toolPart.id,
                  toolPart.tool,
                  toolPart.state.error,
                );
                const invalidArgumentError = invalidArgumentLoopDetector.observe(
                  toolPart.callID || toolPart.id,
                  toolPart.tool,
                  toolPart.state.error,
                );
                const budgetError = toolErrorBudgetDetector.observe(
                  toolPart.callID || toolPart.id,
                  toolPart.tool,
                  toolPart.state.error,
                );
                loopError = unavailableError ?? invalidArgumentError ?? budgetError;
              }
              if (toolPart.state.status === 'completed') {
                unavailableToolLoopDetector.reset();
                invalidArgumentLoopDetector.reset();
              }
              handlePartUpdated(part, delta, options.onStream, state);
              if (loopError !== undefined) {
                success = false;
                failureMessage = loopError;
                diag.onStreamError('message.part.updated', loopError);
                break;
              }
              continue;
            }

            handlePartUpdated(part, delta, options.onStream, state);
            continue;
          }

          if (sseEvent.type === 'message.part.delta') {
            const deltaProps = sseEvent.properties as {
              sessionID: string;
              partID: string;
              field: string;
              delta: string;
            };
            if (deltaProps.field === 'text' && deltaProps.delta) {
              unavailableToolLoopDetector.reset();
              consumeTextDelta(deltaProps.partID, deltaProps.delta);
            }
            continue;
          }

          if (sseEvent.type === 'permission.asked') {
            const permProps = sseEvent.properties as {
              id: string;
              sessionID: string;
              permission?: string;
              patterns?: string[];
              always?: string[];
            };
            if (permProps.sessionID === activeSessionId) {
              try {
                const reply = resolveOpenCodePermissionReply(
                  options.permissionMode,
                  permProps.permission,
                  options.allowedTools !== undefined ? permissionRuleset : undefined,
                );
                emitPermissionAsked(options.onStream, {
                  requestId: permProps.id,
                  sessionId: permProps.sessionID,
                  permission: permProps.permission ?? '',
                  patterns: Array.isArray(permProps.patterns) ? permProps.patterns : [],
                  always: Array.isArray(permProps.always) ? permProps.always : [],
                  reply,
                });
                await withTimeout(
                  (signal) => opencodeApiClient!.permission.reply({
                    requestID: permProps.id,
                    directory: options.cwd,
                    reply,
                  }, { signal }),
                  interactionTimeoutMs,
                  'OpenCode permission reply timed out',
                );
                if (reply === 'reject') {
                  // A rejected permission is a per-tool failure, not a fatal
                  // one: OpenCode returns the rejection to the model as a tool
                  // error and generation continues (verified against a live
                  // server). Aborting here used to turn a single stray
                  // out-of-workspace access into a whole-step failure.
                  log.info(buildPermissionRejectedMessage(permProps.permission), {
                    permission: permProps.permission,
                    patterns: permProps.patterns,
                  });
                }
              } catch (e) {
                success = false;
                failureMessage = getErrorMessage(e);
                break;
              }
            }
            continue;
          }

          if (sseEvent.type === 'question.asked') {
            const questionProps = sseEvent.properties as OpenCodeQuestionAskedProperties;
            if (questionProps.sessionID === activeSessionId) {
              const rejectQuestion = (): Promise<unknown> =>
                withTimeout(
                  (signal) => opencodeApiClient!.question.reject({
                    requestID: questionProps.id,
                    directory: options.cwd,
                  }, { signal }),
                  interactionTimeoutMs,
                  'OpenCode question reject timed out',
                );

              if (!options.onAskUserQuestion) {
                try {
                  await rejectQuestion();
                } catch (e) {
                  success = false;
                  failureMessage = getErrorMessage(e);
                  break;
                }
                continue;
              }

              try {
                const answers = await options.onAskUserQuestion(toQuestionInput(questionProps));
                await withTimeout(
                  (signal) => opencodeApiClient!.question.reply({
                    requestID: questionProps.id,
                    directory: options.cwd,
                    answers: toQuestionAnswers(questionProps, answers),
                  }, { signal }),
                  interactionTimeoutMs,
                  'OpenCode question reply timed out',
                );
              } catch (e) {
                if (e instanceof AskUserQuestionDeniedError) {
                  try {
                    await rejectQuestion();
                  } catch (rejectErr) {
                    success = false;
                    failureMessage = getErrorMessage(rejectErr);
                    break;
                  }
                } else {
                  success = false;
                  failureMessage = getErrorMessage(e);
                  break;
                }
              }
            }
            continue;
          }

          if (sseEvent.type === 'message.updated') {
            const messageProps = sseEvent.properties as {
              info?: {
                sessionID?: string;
                role?: 'assistant' | 'user';
                time?: { completed?: number };
                error?: unknown;
                structured?: unknown;
              };
            };
            const info = messageProps.info;
            const isCurrentAssistantMessage = info?.sessionID === activeSessionId && info?.role === 'assistant';
            if (isCurrentAssistantMessage) {
              if (info?.structured !== undefined && info.structured !== null && typeof info.structured === 'object' && !Array.isArray(info.structured)) {
                capturedStructuredOutput = info.structured as Record<string, unknown>;
              }
              const streamError = extractOpenCodeErrorMessage(info?.error);
              if (streamError) {
                success = false;
                failureMessage = streamError;
                diag.onStreamError('message.updated', streamError);
                break;
              }
              if (info?.time?.completed !== undefined) {
                assistantMessageCycles += 1;
                if (assistantMessageCycles >= messageCycleBudget) {
                  success = false;
                  failureMessage = `OpenCode assistant message cycle budget exceeded (${assistantMessageCycles} cycles in one call)`;
                  diag.onStreamError('message.updated', failureMessage);
                  break;
                }
              }
            }
            continue;
          }

          if (sseEvent.type === 'message.completed') {
            const completedProps = sseEvent.properties as {
              info?: {
                sessionID?: string;
                role?: 'assistant' | 'user';
                error?: unknown;
                structured?: unknown;
              };
            };
            const info = completedProps.info;
            const isCurrentAssistantMessage = info?.sessionID === activeSessionId && info?.role === 'assistant';
            if (isCurrentAssistantMessage) {
              if (info?.structured !== undefined && info.structured !== null && typeof info.structured === 'object' && !Array.isArray(info.structured)) {
                capturedStructuredOutput = info.structured as Record<string, unknown>;
              }
              const streamError = extractOpenCodeErrorMessage(info?.error);
              if (streamError) {
                success = false;
                failureMessage = streamError;
                diag.onStreamError('message.completed', streamError);
                break;
              }
            }
            continue;
          }

          if (sseEvent.type === 'message.failed') {
            const failedProps = sseEvent.properties as {
              info?: {
                sessionID?: string;
                role?: 'assistant' | 'user';
                error?: unknown;
              };
            };
            const info = failedProps.info;
            const isCurrentAssistantMessage = info?.sessionID === activeSessionId && info?.role === 'assistant';
            if (isCurrentAssistantMessage) {
              success = false;
              failureMessage = extractOpenCodeErrorMessage(info?.error) ?? 'OpenCode message failed';
              diag.onStreamError('message.failed', failureMessage);
              break;
            }
            continue;
          }

          if (sseEvent.type === 'session.status') {
            const statusProps = sseEvent.properties as {
              sessionID?: string;
              status?: { type?: string };
            };
            if (statusProps.sessionID === activeSessionId && statusProps.status?.type === 'idle') {
              break;
            }
            continue;
          }

          if (sseEvent.type === 'session.idle') {
            const idleProps = sseEvent.properties as { sessionID: string };
            if (idleProps.sessionID === activeSessionId) {
              break;
            }
            continue;
          }

          if (sseEvent.type === 'session.error') {
            const errorProps = sseEvent.properties as {
              sessionID?: string;
              error?: unknown;
            };
            if (!errorProps.sessionID || errorProps.sessionID === activeSessionId) {
              success = false;
              failureMessage = extractOpenCodeErrorMessage(errorProps.error) ?? 'OpenCode session error';
              diag.onStreamError('session.error', failureMessage);
              break;
            }
            continue;
          }
        }
        } finally {
          // for-await が break 時に行っていた後始末（SSE クローズ）を再現する
          try {
            await streamIterator.return?.(undefined);
          } catch { /* クローズ失敗は結果に影響させない */ }
        }

        // The idle watchdog and external aborts cancel the stream. If the
        // iterator ends without throwing, the loop falls through with
        // success still true - do not let a timed-out or aborted stream
        // pass as a completed call (a stalled stream after a rejected
        // permission would otherwise be reported as done).
        if (success && streamAbortController.signal.aborted && (abortCause === 'timeout' || abortCause === 'external')) {
          success = false;
          failureMessage = abortCause === 'timeout' ? timeoutMessage : OPENCODE_STREAM_ABORTED_MESSAGE;
        }

        content = [...textContentParts.values()].join('\n');
        if (!success && !streamAbortController.signal.aborted) {
          streamAbortController.abort();
        }
        await awaitPromptCompletion();
        if (promptError !== undefined) {
          if (success) {
            success = false;
            failureMessage = promptError;
          } else if (!failureMessage) {
            failureMessage = promptError;
          }
        }
        diag.onCompleted(success ? 'normal' : 'error', success ? undefined : failureMessage);

        if (!success) {
          const message = failureMessage || 'OpenCode execution failed';
          // 無音タイムアウトで止めた場合、死因はサーバが握った 429 かもしれない。
          // メッセージ文字列だけでは判別できないため、セッションを検死する。
          if (
            abortCause === 'timeout'
            && !containsRateLimitError(message)
            && opencodeApiClient !== undefined
            && activeSessionId !== undefined
          ) {
            const rateLimitMessage = await postmortemRateLimitError(
              opencodeApiClient,
              activeSessionId,
              options.cwd,
            );
            if (rateLimitMessage !== undefined) {
              // プロバイダ由来の生エラー文はリクエスト内容やアカウント情報を
              // 含みうるため、分類済みの事実だけを永続化する。
              log.warn('OpenCode stream stalled on a provider rate limit', {
                sessionId: activeSessionId,
                model: options.model,
              });
              // 検死で 429 と確定済み。message 文字列に 429 の語が含まれるとは
              // 限らない（statusCode だけで判定した場合）ため再判定はしない。
              const rateLimitedResponse = this.buildRateLimitedResponse(agentType, activeSessionId, rateLimitMessage);
              emitResult(options.onStream, false, rateLimitedResponse.error ?? rateLimitedResponse.content, activeSessionId);
              return rateLimitedResponse;
            }
          }
          if (containsRateLimitError(message)) {
            const rateLimitedResponse = this.buildRateLimitedResponse(agentType, activeSessionId, message);
            emitResult(options.onStream, false, rateLimitedResponse.error ?? rateLimitedResponse.content, activeSessionId);
            return rateLimitedResponse;
          }
          const lowerMessage = message.toLowerCase();
          // Failures that point at the native json_schema request itself: a
          // model that never emits the StructuredOutput tool ("did not produce
          // structured output"), or a gateway/model that rejects the json_schema
          // response format outright (surfaced as an upstream request error).
          // These fall back to formatless structured output; generic transient
          // errors (transport/network) must not, or they would burn the one-shot
          // fallback budget before a real format failure arrives.
          const isNativeStructuredOutputFailure =
            lowerMessage.includes('did not produce structured output')
            || lowerMessage.includes('upstream request failed');
          if (
            options.outputSchema !== undefined
            && !disableNativeStructuredOutput
            && isNativeStructuredOutputFailure
          ) {
            // Fall back to formatless structured output once — hand-written JSON
            // validated by the downstream correction retry — before giving up.
            disableNativeStructuredOutput = true;
            maxAttempts = Math.max(maxAttempts, attempt + 1);
            log.info('Native structured output failed; retrying without json_schema format', { agentType, attempt, message });
            await this.waitForRetryDelay(attempt, options.abortSignal);
            continue;
          }

          const retriable = this.isRetriableError(message, streamAbortController.signal.aborted, abortCause);
          if (retriable && attempt < OPENCODE_RETRY_MAX_ATTEMPTS) {
            log.info('Retrying OpenCode call after transient failure', { agentType, attempt, message });
            await this.waitForRetryDelay(attempt, options.abortSignal);
            continue;
          }

          emitResult(options.onStream, false, message, activeSessionId);
          return {
            persona: agentType,
            status: 'error',
            content: message,
            error: message,
            timestamp: new Date(),
            sessionId: activeSessionId,
          };
        }

        const trimmed = content.trim();
        emitResult(options.onStream, true, trimmed, activeSessionId);

        // format 要求時に structured がイベントで捕捉できなかった場合は、
        // 本文の末尾 JSON をフォールバックとして採取する（検証は下流で行う）。
        if (capturedStructuredOutput === undefined && options.outputSchema !== undefined) {
          try {
            const parsed = parseLastJsonBlock(trimmed);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
              capturedStructuredOutput = parsed as Record<string, unknown>;
            } else {
              log.debug('Structured output fallback found non-object JSON', { agentType });
            }
          } catch (fallbackError) {
            // フォールバック採取の失敗は握りつぶすが、調査用に痕跡は残す
            // （下流の検証と是正リトライに委ねる）。
            log.debug('Structured output fallback extraction failed', {
              agentType,
              error: getErrorMessage(fallbackError),
            });
          }
        }

        return {
          persona: agentType,
          status: 'done',
          content: trimmed,
          timestamp: new Date(),
          sessionId: activeSessionId,
          ...(capturedStructuredOutput !== undefined ? { structuredOutput: capturedStructuredOutput } : {}),
        };
      } catch (error) {
        const message = getErrorMessage(error);
        const errorMessage = streamAbortController.signal.aborted
          ? abortCause === 'timeout'
            ? timeoutMessage
            : abortCause === 'prompt' && promptError !== undefined
              ? promptError
              : OPENCODE_STREAM_ABORTED_MESSAGE
          : message;

        if (containsRateLimitError(errorMessage)) {
          const rateLimitedResponse = this.buildRateLimitedResponse(agentType, sessionId, errorMessage);
          if (sessionId) {
            emitResult(options.onStream, false, rateLimitedResponse.error ?? rateLimitedResponse.content, sessionId);
          }
          return rateLimitedResponse;
        }

        diagRef?.onCompleted(
          abortCause === 'timeout' ? 'timeout' : streamAbortController.signal.aborted && abortCause !== 'prompt' ? 'abort' : 'error',
          errorMessage,
        );

        const retriable = this.isRetriableError(errorMessage, streamAbortController.signal.aborted, abortCause);
        if (retriable && attempt < OPENCODE_RETRY_MAX_ATTEMPTS) {
          log.info('Retrying OpenCode call after transient exception', { agentType, attempt, errorMessage });
          await this.waitForRetryDelay(attempt, options.abortSignal);
          continue;
        }

        if (sessionId) {
          emitResult(options.onStream, false, errorMessage, sessionId);
        }

        return {
          persona: agentType,
          status: 'error',
          content: errorMessage,
          error: errorMessage,
          timestamp: new Date(),
          sessionId,
        };
      } finally {
        if (idleTimeoutId !== undefined) {
          clearTimeout(idleTimeoutId);
        }
        if (options.abortSignal) {
          options.abortSignal.removeEventListener('abort', onExternalAbort);
        }
        if (!streamAbortController.signal.aborted) {
          streamAbortController.abort();
        }
        await awaitPromptCompletion();
        release?.();
      }
    }

    throw new Error('Unreachable: OpenCode retry loop exhausted without returning');
  }

  async compactSession(options: OpenCodeCompactSessionOptions): Promise<void> {
    const parsedModel = parseProviderModel(options.model, 'OpenCode model');
    const fullModel = `${parsedModel.providerID}/${parsedModel.modelID}`;
    const acquired = await acquireClient(
      fullModel,
      options.opencodeApiKey,
      options.childProcessEnv,
      options.abortSignal,
      options.sessionId,
    );

    try {
      await withTimeout(
        (signal) => acquired.client.session.summarize({
          sessionID: options.sessionId,
          directory: options.cwd,
          providerID: parsedModel.providerID,
          modelID: parsedModel.modelID,
          auto: false,
        }, { signal }),
        OPENCODE_INTERACTION_TIMEOUT_MS,
        'OpenCode session summarize timed out',
        options.abortSignal,
      );
    } finally {
      acquired.release();
    }
  }

  /** Call OpenCode with a custom agent configuration (system prompt + prompt) */
  async callCustom(
    agentName: string,
    prompt: string,
    systemPrompt: string,
    options: OpenCodeCallOptions,
  ): Promise<AgentResponse> {
    return this.call(agentName, prompt, {
      ...options,
      systemPrompt,
    });
  }
}

const defaultClient = new OpenCodeClient();

export async function callOpenCode(
  agentType: string,
  prompt: string,
  options: OpenCodeCallOptions,
): Promise<AgentResponse> {
  return defaultClient.call(agentType, prompt, options);
}

export async function callOpenCodeCustom(
  agentName: string,
  prompt: string,
  systemPrompt: string,
  options: OpenCodeCallOptions,
): Promise<AgentResponse> {
  return defaultClient.callCustom(agentName, prompt, systemPrompt, options);
}

export async function compactOpenCodeSession(options: OpenCodeCompactSessionOptions): Promise<void> {
  return defaultClient.compactSession(options);
}
