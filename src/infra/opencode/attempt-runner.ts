/**
 * OpenCode SDK integration for agent interactions
 *
 * Uses @opencode-ai/sdk/v2 for native TypeScript integration.
 * Follows the same patterns as the Codex client.
 */

import type { AgentResponse } from '../../core/models/index.js';
import { mapsToOpenCodeEditPermission } from './allowedTools.js';
import { AskUserQuestionDeniedError } from '../../core/workflow/ask-user-question-error.js';
import { parseStructuredOutputObject } from '../../agents/structured-caller/shared.js';
import { createLogger, getErrorMessage, createStreamDiagnostics, type StreamDiagnostics } from '../../shared/utils/index.js';
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
  describeOpenCodeStreamTrackingLimitFailure,
  emitInit,
  emitText,
  emitThinking,
  emitPermissionAsked,
  emitPermissionSummary,
  emitResult,
  flushSensitiveTextStreams,
  handlePartUpdated,
  OPENCODE_STREAM_TRACKING_LIMIT_MESSAGE,
  trackOpenCodeReasoningBytes,
} from './OpenCodeStreamHandler.js';
import {
  buildToolGuardCorrectionPrompt,
  buildToolGuardRetryPrompt,
  clearToolGuardPendingCorrection,
  createToolGuardRecoveryState,
  markToolGuardCorrectionPending,
  markToolGuardFreshSessionUsed,
  resolveToolGuardRecoveryAction,
  type ToolGuardRecoverableFailure,
} from './tool-guard.js';
import {
  resolveOpenCodeGuardSuite,
  type OpenCodeGuardAbortKind,
  type OpenCodeGuardEvaluation,
  type OpenCodeGuardSuite,
} from './guards/index.js';
import { extractOpenCodeToolRejection } from './guards/tool-events.js';
import {
  STRUCTURED_OUTPUT_TOOL_NAME,
  buildFormatlessStructuredPrompt,
  createStructuredOutputRecoveryState,
  degradeToFormatless,
  planStructuredOutputAttempt,
  recoverStaleSession,
  shouldDegradeToFormatless,
  shouldRecoverStaleSession,
} from './structured-output-recovery.js';
import {
  parseServerAvailableTools,
} from './unavailable-tool-recovery.js';
import { createOpenCodeSessionLifecycle } from './session-lifecycle.js';
import type { OpenCodeSessionLifecycle } from './session-lifecycle.js';
import {
  AGENT_FAILURE_CATEGORIES,
  type AgentFailureCategory,
} from '../../shared/types/agent-failure.js';
import { buildRateLimitedResponseFields, containsRateLimitError } from '../rate-limit/detection.js';
import {
  createSensitiveTextStreamRedactor,
  sanitizeSensitiveText,
  sanitizeSensitiveTextWithKnownValues,
  sanitizeSensitiveValue,
} from '../../shared/utils/sensitiveText.js';
import {
  maskOpenCodeToolContentInText,
  sanitizeOpenCodeToolInput,
} from './tool-input-sanitizer.js';
import {
  acquireOpenCodeClient,
  OpenCodeSharedServerInvalidationError,
  resetSharedServerPool,
  sharedServerInvalidationError,
  throwIfSharedServerInvalidated,
  type OpencodeClient,
} from './server-pool.js';
import { compactOpenCodeSessionWithCoordinator } from './compaction-coordinator.js';

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

function sanitizeToolCallInputForLogging(tool: string, value: Record<string, unknown>): unknown {
  return sanitizeOpenCodeToolInput(value, tool);
}

function sanitizeToolGuardFailure(
  failure: ToolGuardRecoverableFailure,
  tool: string,
  input: unknown,
): ToolGuardRecoverableFailure {
  return {
    ...failure,
    message: sanitizeSensitiveTextWithKnownValues(
      maskOpenCodeToolContentInText(failure.message, tool, input),
      input,
    ),
  };
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

/**
 * OpenCode がツール呼び出しを拒否したときの、ツール名とエラー文を取り出す。
 *
 * OpenCode は2種類の拒否を `invalid` という擬似ツールの **status: 'completed'**
 * として返す。存在しないツール名（`Model tried to call unavailable tool 'run'`）と、
 * 実在ツールの引数不備（`Required argument 'filePath' is missing or invalid`）。
 *
 * 3 つの検出器はどれも status === 'error' でしか観測しないため、拒否がまるごと
 * 死角に入る。実測: qwen が implement で 195 回連続して invalid を踏み、
 * ループ検出も引数不正検出もエラー予算も一度も発火せず、cycle budget を
 * 焼き切って abort した。しかも invalid は completed なので「ツールが成功した」
 * として空転の計数までリセットしていた。
 *
 * 本来呼ぼうとしたツール名は state.input.tool に入っている。検出器は連続性と
 * 総量で判断するので、1〜2 回の空振り（モデルが自力で直す場合）では発火しない。
 */
const OPENCODE_STREAM_ABORTED_MESSAGE = 'OpenCode execution aborted';
const OPENCODE_PENDING_PART_DELTA_LIMIT_PROTOCOL_FAILURE =
  'OpenCode stream protocol failure: unresolved part delta count exceeded';
const OPENCODE_RETRY_MAX_ATTEMPTS = 3;
const OPENCODE_RETRY_BASE_DELAY_MS = 250;
const OPENCODE_INTERACTION_TIMEOUT_MS = 5000;
const OPENCODE_SESSION_ABORT_TIMEOUT_MS = 5000;
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
type OpenCodeSessionSnapshot = NonNullable<Awaited<ReturnType<OpencodeClient['session']['get']>>['data']>;
type OpenCodeAbortCause = 'timeout' | OpenCodeGuardAbortKind | 'external' | 'prompt' | 'server';

function resolveOpenCodeAbortFailureCategory(
  abortCause: OpenCodeAbortCause | undefined,
): AgentFailureCategory | undefined {
  switch (abortCause) {
    case 'deadline':
      return AGENT_FAILURE_CATEGORIES.PART_TIMEOUT;
    case 'external':
      return AGENT_FAILURE_CATEGORIES.EXTERNAL_ABORT;
    default:
      return undefined;
  }
}

function getToolGuardFailureFingerprint(failure: ToolGuardRecoverableFailure): string {
  return failure.kind === 'edit_conflict_loop' ? failure.signature : failure.fingerprint;
}

let nextProvisionalId = 1;
export async function getOpenCodeSessionSnapshot(
  model: string,
  sessionID: string,
  directory: string,
  apiKey?: string,
): Promise<OpenCodeSessionSnapshot> {
  const { client, release, invalidationSignal } = await acquireOpenCodeClient(
    model,
    apiKey,
    undefined,
    undefined,
    sessionID,
  );
  try {
    const result = await client.session.get({ sessionID, directory }, { signal: invalidationSignal });
    throwIfSharedServerInvalidated(invalidationSignal);
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
 * session.error を流さない。認証済み transport が追加する無音ウォッチドッグで
 * セッションを停止した場合に、ここで死因を確かめる。
 *
 * 判定するのは「最新の assistant メッセージ」だけに限る。sessionId は phase や
 * resume で再利用されるため、過去の assistant に残る古い 429 を今回の死因と
 * 誤認しないようにする。
 */
async function postmortemRateLimitError(
  client: OpencodeClient,
  sessionID: string,
  directory: string,
  abortSignal: AbortSignal,
): Promise<string | undefined> {
  let messages: OpenCodeSessionMessages;
  try {
    const result = await withTimeout(
      (signal) => client.session.messages({ sessionID, directory }, { signal }),
      resolvePostmortemTimeoutMs(),
      'OpenCode rate limit postmortem timed out',
      abortSignal,
    );
    if (!result.data) {
      return undefined;
    }
    messages = result.data;
  } catch (error) {
    if (abortSignal.aborted) throw error;
    // 検死そのものの失敗（RPC エラー・ハング）で本来のエラーを覆い隠さない。
    log.debug('Rate limit postmortem could not read session messages', {
      sessionID,
      error: sanitizeSensitiveText(getErrorMessage(error)),
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
  const { client, release, invalidationSignal } = await acquireOpenCodeClient(
    model,
    apiKey,
    undefined,
    undefined,
    sessionID,
  );
  try {
    const result = await client.session.messages({ sessionID, directory }, { signal: invalidationSignal });
    throwIfSharedServerInvalidated(invalidationSignal);
    if (!result.data) {
      throw new Error(`OpenCode session messages not found: ${sessionID}`);
    }
    return result.data;
  } finally {
    release();
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

export function resetSharedServer(): void {
  resetSharedServerPool();
}

let sharedServerExitCleanupRegistered = false;

function registerSharedServerExitCleanup(): void {
  if (sharedServerExitCleanupRegistered) return;
  process.once('exit', resetSharedServer);
  sharedServerExitCleanupRegistered = true;
}

/** 要約は本文量に比例して伸びるため、対話 RPC より長く待つ。 */
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

async function withAbortSignal<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) throw new Error(OPENCODE_STREAM_ABORTED_MESSAGE);
  let removeListener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = (): void => reject(new Error(OPENCODE_STREAM_ABORTED_MESSAGE));
    signal.addEventListener('abort', onAbort, { once: true });
    removeListener = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    removeListener?.();
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

interface GuardIngressState {
  readonly rawOffsets: Map<string, number>;
  readonly partTypes: Map<string, string>;
  readonly pendingPartDeltas: Map<number, BufferedPartDelta>;
  nextPartDeltaSequence: number;
  nextPartDeltaSequenceToFlush: number;
  pendingPartDeltaBytes: number;
  readonly pendingPartDeltaByteLimit: number;
  readonly pendingPartDeltaCountLimit: number;
  readonly pendingPartDeltaLimitReason: 'text_bytes' | 'reasoning_bytes';
  protocolFailure: string | undefined;
  readonly echoState: { remainingPrompts: string[] };
}

interface BufferedPartDelta {
  readonly sequence: number;
  readonly partId: string;
  readonly delta: string;
  readonly bytes: number;
  readonly event: OpenCodeStreamEvent;
}

function bufferPartDelta(
  event: OpenCodeStreamEvent,
  partId: string,
  delta: string,
  state: GuardIngressState,
): void {
  const bytes = Buffer.byteLength(delta, 'utf8');
  if (state.pendingPartDeltas.size >= state.pendingPartDeltaCountLimit) {
    state.protocolFailure = OPENCODE_PENDING_PART_DELTA_LIMIT_PROTOCOL_FAILURE;
    return;
  }
  if (state.pendingPartDeltaBytes + bytes > state.pendingPartDeltaByteLimit) {
    throw new Error(describeOpenCodeStreamTrackingLimitFailure(state.pendingPartDeltaLimitReason));
  }
  const sequence = state.nextPartDeltaSequence;
  state.nextPartDeltaSequence += 1;
  state.pendingPartDeltas.set(sequence, { sequence, partId, delta, bytes, event });
  state.pendingPartDeltaBytes += bytes;
}

function flushResolvedPartDeltas(state: GuardIngressState): OpenCodeStreamEvent[] {
  const events: OpenCodeStreamEvent[] = [];
  while (true) {
    const pending = state.pendingPartDeltas.get(state.nextPartDeltaSequenceToFlush);
    if (pending === undefined) break;
    const partType = state.partTypes.get(pending.partId);
    if (partType === undefined) break;

    state.pendingPartDeltas.delete(pending.sequence);
    state.nextPartDeltaSequenceToFlush += 1;
    state.pendingPartDeltaBytes -= pending.bytes;
    if (partType !== 'text' && partType !== 'reasoning') continue;

    const delta = partType === 'text'
      ? stripPromptEcho(pending.delta, state.echoState)
      : pending.delta;
    events.push({
      ...pending.event,
      properties: {
        ...pending.event.properties,
        partID: pending.partId,
        field: 'text',
        delta,
        guardPartType: partType,
      },
    } as OpenCodeStreamEvent);
  }
  return events;
}

function normalizeGuardIngressEvent(
  event: OpenCodeStreamEvent,
  activeSessionId: string,
  state: GuardIngressState,
): OpenCodeStreamEvent[] {
  if (event.type === 'message.part.updated') {
    const part = event.properties.part as OpenCodePart;
    const normalizedPart = {
      ...part,
      sessionID: typeof part.sessionID === 'string' ? part.sessionID : activeSessionId,
    } as OpenCodePart;
    state.partTypes.set(part.id, part.type);
    if (part.type !== 'text' && part.type !== 'reasoning') {
      return [
        { ...event, properties: { ...event.properties, part: normalizedPart } },
        ...flushResolvedPartDeltas(state),
      ];
    }
    const text = (part as OpenCodeTextPart).text;
    const previous = state.rawOffsets.get(part.id) ?? 0;
    const providedDelta = typeof event.properties.delta === 'string'
      ? event.properties.delta
      : undefined;
    const currentDelta = providedDelta
      ?? (text.length > previous ? text.slice(previous) : '');
    state.rawOffsets.set(part.id, providedDelta === undefined ? text.length : previous + currentDelta.length);
    if (state.pendingPartDeltas.size === 0) {
      const delta = part.type === 'text'
        ? stripPromptEcho(currentDelta, state.echoState)
        : currentDelta;
      return [{
        ...event,
        properties: {
          ...event.properties,
          part: { ...normalizedPart, text: delta },
          delta,
        },
      } as OpenCodeStreamEvent];
    }
    if (currentDelta.length > 0) {
      bufferPartDelta(event, part.id, currentDelta, state);
    }
    const normalizedEvent = {
      ...event,
      properties: {
        ...event.properties,
        part: normalizedPart,
        delta: '',
      },
    } as OpenCodeStreamEvent;
    return [normalizedEvent, ...flushResolvedPartDeltas(state)];
  }
  if (event.type !== 'message.part.delta') return [event];
  const properties = event.properties as Record<string, unknown>;
  if (properties.field !== 'text' || typeof properties.delta !== 'string') return [event];
  const partId = typeof properties.partID === 'string' ? properties.partID : undefined;
  const partType = partId === undefined ? 'text' : state.partTypes.get(partId);
  if (partId !== undefined) {
    state.rawOffsets.set(partId, (state.rawOffsets.get(partId) ?? 0) + properties.delta.length);
  }
  if (partId !== undefined && (partType === undefined || state.pendingPartDeltas.size > 0)) {
    if (properties.delta.length > 0) {
      bufferPartDelta(event, partId, properties.delta, state);
    }
    return flushResolvedPartDeltas(state);
  }
  const delta = partType === 'reasoning'
    ? properties.delta
    : stripPromptEcho(properties.delta, state.echoState);
  return [{
    ...event,
    properties: { ...properties, delta, guardPartType: partType },
  } as OpenCodeStreamEvent];
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

interface OpenCodeCallState {
  recoveryState: ReturnType<typeof createStructuredOutputRecoveryState>;
  toolGuardRecovery: ReturnType<typeof createToolGuardRecoveryState>;
  maxAttempts: number;
}

const RETRY_ATTEMPT = Symbol('retry-open-code-attempt');

export class OpenCodeAttemptRunner {
  private isRetriableError(message: string, abortCause?: OpenCodeAbortCause): boolean {
    if (abortCause === 'timeout') {
      return true;
    }

    if (abortCause === 'prompt') {
      const lower = message.toLowerCase();
      return OPENCODE_RETRYABLE_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
    }

    if (abortCause) {
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
    retryCount: number,
  ): AgentResponse {
    return {
      persona: agentType,
      timestamp: new Date(),
      sessionId,
      ...buildRateLimitedResponseFields('opencode', 'sdk_error', message),
      ...(retryCount > 0 ? { retryCount } : {}),
    };
  }

  /** Call OpenCode with an agent prompt */
  async call(
    agentType: string,
    prompt: string,
    options: OpenCodeCallOptions,
  ): Promise<AgentResponse> {
    const parsedModel = parseProviderModel(options.model, 'OpenCode model');
    const resolvedModel = `${parsedModel.providerID}/${parsedModel.modelID}`;
    const guardSuite = resolveOpenCodeGuardSuite(options.guards, resolvedModel);
    log.debug('Resolved OpenCode guard policy', {
      model: resolvedModel,
      profile: guardSuite.profile,
      enabledGuardIds: guardSuite.enabledGuardIds,
      callTimeoutMs: guardSuite.policy.callTimeoutMs,
      messageCycleBudget: guardSuite.policy.messageCycleBudget,
      exactToolRepeatLimit: guardSuite.policy.exactToolRepeatLimit,
      streamEventLimit: guardSuite.policy.streamEventLimit,
      streamLimits: guardSuite.policy.streamLimits,
      sensitiveCandidateLimit: guardSuite.policy.sensitiveCandidateLimit,
      sensitiveCandidateByteLimit: guardSuite.policy.sensitiveCandidateByteLimit,
      sensitiveSourceScanByteLimit: guardSuite.policy.sensitiveSourceScanByteLimit,
    });
    const callAbortController = new AbortController();
    const abortFromCaller = (): void => callAbortController.abort(options.abortSignal?.reason);
    if (options.abortSignal?.aborted) abortFromCaller();
    else options.abortSignal?.addEventListener('abort', abortFromCaller, { once: true });
    guardSuite.startCall((failure) => callAbortController.abort(new Error(failure.verdict.reason)));
    const guardedOptions: OpenCodeCallOptions & { abortSignal: AbortSignal } = {
      ...options,
      abortSignal: callAbortController.signal,
    };
    const callState: OpenCodeCallState = {
      recoveryState: createStructuredOutputRecoveryState(options.outputSchema !== undefined),
      toolGuardRecovery: createToolGuardRecoveryState(guardSuite.policy.toolGuard.editCorrectionLimit),
      maxAttempts: OPENCODE_RETRY_MAX_ATTEMPTS,
    };
    const hasInitialSessionId = options.sessionId !== undefined;
    const provisionalKey = `provisional-${nextProvisionalId++}`;
    try {
      for (let attempt = 1; attempt <= callState.maxAttempts; attempt++) {
        guardedOptions.onActivity?.({ kind: 'attempt_started' });
        const result = await this.runAttempt(
          agentType,
          prompt,
          guardedOptions,
          attempt,
          hasInitialSessionId,
          provisionalKey,
          guardSuite,
          callState,
        );
        if (result !== RETRY_ATTEMPT) return result;
      }
      throw new Error('Unreachable: OpenCode retry loop exhausted without returning');
    } finally {
      guardSuite.stopCall();
      options.abortSignal?.removeEventListener('abort', abortFromCaller);
    }
  }

  private async runAttempt(
    agentType: string,
    prompt: string,
    options: OpenCodeCallOptions & { abortSignal: AbortSignal },
    attempt: number,
    hasInitialSessionId: boolean,
    provisionalKey: string,
  guardSuite: OpenCodeGuardSuite,
  callState: OpenCodeCallState,
  ): Promise<AgentResponse | typeof RETRY_ATTEMPT> {
  const streamAbortController = new AbortController();
  let timeoutMessage = OPENCODE_STREAM_ABORTED_MESSAGE;
  let abortCause: OpenCodeAbortCause | undefined;
  let diagRef: StreamDiagnostics | undefined;
  let release: (() => void) | undefined;
  let opencodeApiClient: OpencodeClient | undefined;
  let sessionLifecycle: OpenCodeSessionLifecycle | undefined;
  let serverInvalidationError: OpenCodeSharedServerInvalidationError | undefined;
  let removeServerInvalidationListener: (() => void) | undefined;
  let pendingResultEmission: {
    success: boolean;
    content: string;
    sessionId: string;
  } | undefined;
  let pendingCompletion: {
    reason: 'normal' | 'timeout' | 'abort' | 'error';
    detail?: string;
  } | undefined;
  let finalizationInvalidationError: OpenCodeSharedServerInvalidationError | undefined;
  let attemptCleanupError: AggregateError | undefined;
  const structuredAttemptPlan = planStructuredOutputAttempt(callState.recoveryState, hasInitialSessionId);
  // tool-guard fresh recovery 後の attempt は fresh session を強制する。
  // plan の sessionMode を実態に合わせないと、後段の
  // stale StructuredOutput 判定（plan.sessionMode === 'resume' が条件）が
  // 「fresh なのに resume 扱い」で誤発動し、救済の連鎖で attempt が増える。
  const attemptPlan = callState.toolGuardRecovery.freshSessionUsed
    ? { ...structuredAttemptPlan, sessionMode: 'fresh' as const }
    : structuredAttemptPlan;
  // tool-loop correction attempt は直前の attempt のセッションを再開する
  // （同一セッション内で1回だけの是正指示 — tool-guard.ts 参照）。
  const pendingToolGuardCorrection = callState.toolGuardRecovery.pendingCorrection;
  if (pendingToolGuardCorrection !== undefined) {
    callState.toolGuardRecovery = clearToolGuardPendingCorrection(callState.toolGuardRecovery);
  }
  let sessionId: string | undefined = pendingToolGuardCorrection !== undefined
    ? pendingToolGuardCorrection.sessionId
    : (attemptPlan.sessionMode === 'fresh' ? undefined : options.sessionId);
  let promptCompletion: Promise<unknown> | undefined;
  let promptCompletionWait: Promise<void> | undefined;
  let promptError: string | undefined;
  const attemptSensitiveSources: unknown[] = [
    { opencodeApiKey: options.opencodeApiKey },
    options.childProcessEnv,
  ];
  const state = createStreamTrackingState(guardSuite.policy.streamLimits, guardSuite.sensitiveValues);
  let initialGuardFailure: OpenCodeGuardEvaluation | undefined;
  for (const source of attemptSensitiveSources) {
    initialGuardFailure ??= guardSuite.onInitialSource(source).failure;
  }
  const isTrackingLimitFailureMessage = (message: string): boolean => (
    message === OPENCODE_STREAM_TRACKING_LIMIT_MESSAGE
    || message === describeOpenCodeStreamTrackingLimitFailure('event_count')
    || message === describeOpenCodeStreamTrackingLimitFailure('tracked_id_count')
    || message === describeOpenCodeStreamTrackingLimitFailure('text_bytes')
    || message === describeOpenCodeStreamTrackingLimitFailure('reasoning_bytes')
    || message === describeOpenCodeStreamTrackingLimitFailure('sensitive_sources')
    || message.startsWith('OpenCode sensitive value budget exceeded:')
  );

  const sanitizeAttemptError = (message: string): string => (
    isTrackingLimitFailureMessage(message)
      ? message
      : sanitizeSensitiveTextWithKnownValues(message, state.sensitiveSources)
  );
  const interactionTimeoutMs = options.interactionTimeoutMs ?? OPENCODE_INTERACTION_TIMEOUT_MS;
  const promptCompletionTimeoutMessage = 'OpenCode prompt completion timed out';

  const awaitPromptCompletion = (): Promise<void> => {
    if (!promptCompletion) {
      return Promise.resolve();
    }

    promptCompletionWait ??= (async () => {
      try {
        await withTimeout(
          () => promptCompletion!,
          interactionTimeoutMs,
          promptCompletionTimeoutMessage,
          options.abortSignal,
        );
      } catch (error) {
        promptError ??= getErrorMessage(error);
      }
    })();
    return promptCompletionWait;
  };

  const throwIfServerInvalidated = (): void => {
    if (serverInvalidationError !== undefined) {
      throw serverInvalidationError;
    }
  };

  const currentServerInvalidationError = (): OpenCodeSharedServerInvalidationError | undefined => (
    serverInvalidationError
  );

  const buildAttemptErrorResponse = (error: unknown): AgentResponse => {
    const errorMessage = sanitizeAttemptError(getErrorMessage(error));
    const failureCategory = resolveOpenCodeAbortFailureCategory(abortCause);
    return {
      persona: agentType,
      status: 'error',
      content: errorMessage,
      error: errorMessage,
      timestamp: new Date(),
      sessionId,
      ...(failureCategory === undefined ? {} : { failureCategory }),
      ...(attempt > 1 ? { retryCount: attempt - 1 } : {}),
    };
  };

  const buildServerInvalidationResponse = (
    invalidationError: OpenCodeSharedServerInvalidationError,
  ): AgentResponse => buildAttemptErrorResponse(invalidationError);

  const combineAttemptAndCleanupErrors = (attemptError: unknown, cleanupError: unknown): AggregateError => {
    return new AggregateError(
      [attemptError, cleanupError],
      `OpenCode attempt and session cleanup failed: ${getErrorMessage(attemptError)}; ${getErrorMessage(cleanupError)}`,
    );
  };

  const scheduleResultEmission = (
    success: boolean,
    content: string,
    resultSessionId: string,
  ): void => {
    pendingResultEmission = {
      success,
      content: success ? content : sanitizeAttemptError(content),
      sessionId: resultSessionId,
    };
  };

  const onExternalAbort = (): void => {
    const guardFailure = guardSuite.getCallFailure();
    abortCause = guardFailure?.verdict.abortKind ?? 'external';
    streamAbortController.abort(options.abortSignal?.reason);
  };

  if (options.abortSignal) {
    if (options.abortSignal.aborted) {
      onExternalAbort();
    } else {
      options.abortSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const throwIfCallAborted = (): void => {
    if (!options.abortSignal?.aborted) return;
    const failure = guardSuite.getCallFailure();
    throw new Error(failure?.verdict.reason ?? OPENCODE_STREAM_ABORTED_MESSAGE);
  };

  guardSuite.startAttempt((failure) => {
    if (streamAbortController.signal.aborted) return;
    timeoutMessage = failure.verdict.reason;
    log.warn(failure.verdict.reason, { sessionId, model: options.model });
    abortCause = 'timeout';
    streamAbortController.abort(new Error(failure.verdict.reason));
  });

  let attemptResult: AgentResponse | typeof RETRY_ATTEMPT;
  try {
    attemptResult = await (async (): Promise<AgentResponse | typeof RETRY_ATTEMPT> => {
  try {
    if (initialGuardFailure !== undefined) {
      throw new Error(initialGuardFailure.verdict.reason);
    }
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

    let acquired = await acquireOpenCodeClient(
      fullModel,
      options.opencodeApiKey,
      options.childProcessEnv,
      options.abortSignal,
      sessionId ?? provisionalKey,
      options.preparedMcp,
    );
    throwIfCallAborted();
    registerSharedServerExitCleanup();
    const onServerInvalidated = (): void => {
      serverInvalidationError = sharedServerInvalidationError(acquired.invalidationSignal);
      if (!streamAbortController.signal.aborted) {
        abortCause = 'server';
        streamAbortController.abort(serverInvalidationError);
      }
    };
    if (acquired.invalidationSignal.aborted) {
      onServerInvalidated();
    } else {
      acquired.invalidationSignal.addEventListener('abort', onServerInvalidated, { once: true });
      removeServerInvalidationListener = () => {
        acquired.invalidationSignal.removeEventListener('abort', onServerInvalidated);
      };
    }
    opencodeApiClient = acquired.client;
    release = acquired.release;
    throwIfServerInvalidated();
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
      throwIfCallAborted();
      const sessionResult = await opencodeApiClient.session.create({
        directory: options.cwd,
        permission: sessionPermission,
      }, { signal: streamAbortController.signal });
      throwIfCallAborted();

      sessionId = sessionResult.data?.id;
      if (!sessionId) {
        throw new Error('Failed to create OpenCode session');
      }
      throwIfServerInvalidated();

      if (provisionalKey !== undefined) {
        const realAcquired = await acquired.acquireSession(
          sessionId,
          options.abortSignal,
        );
        throwIfCallAborted();
        release!();
        acquired = realAcquired;
        opencodeApiClient = realAcquired.client;
        release = realAcquired.release;
        throwIfServerInvalidated();
      }
    }

    const activeSessionId = sessionId;
    if (activeSessionId === undefined) {
      throw new Error('OpenCode session ID is required');
    }
    sessionLifecycle = createOpenCodeSessionLifecycle({
      client: opencodeApiClient,
      sessionId: activeSessionId,
      directory: options.cwd,
      abortTimeoutMs: OPENCODE_SESSION_ABORT_TIMEOUT_MS,
      invalidateServer: acquired.invalidate,
    });

    const { stream } = await opencodeApiClient.event.subscribe(
      { directory: options.cwd },
      { signal: streamAbortController.signal },
    );
    throwIfCallAborted();
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
    // native format 劣化後の attempt は、structured_json_schema_instruction
    // でスキーマと fenced JSON 契約・StructuredOutput 禁止を明示したプロンプトへ
    // 包み直す。この attempt は session も fresh 強制済み（attemptPlan 参照）。
    const basePromptText = attemptPlan.structuredMode === 'formatless' && options.outputSchema !== undefined
      ? buildFormatlessStructuredPrompt(prompt, options.outputSchema, options.language ?? 'en')
      : prompt;
    // tool-guard recovery の attempt:
    // - correction: 同一セッション再開なので元プロンプトは再送しない
    //   （セッションに文脈がある）。是正指示だけを送る。
    // - fresh session: workspace の
    //   途中成果・上書き禁止・再読込を明記した前置文で元プロンプトを包む。
    const promptText = pendingToolGuardCorrection !== undefined
      ? pendingToolGuardCorrection.prompt
      : callState.toolGuardRecovery.freshSessionUsed && callState.toolGuardRecovery.freshReason !== undefined
        ? buildToolGuardRetryPrompt(basePromptText, callState.toolGuardRecovery.freshReason)
        : basePromptText;
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
      ...(attemptPlan.structuredMode === 'native' && options.outputSchema !== undefined
        ? { format: { type: 'json_schema' as const, schema: options.outputSchema, retryCount: 2 } }
        : {}),
      parts: [{ type: 'text' as const, text: promptText }],
    };
    const promptPayloadForSdk = promptPayload as unknown as Parameters<typeof opencodeApiClient.session.promptAsync>[0];
    throwIfCallAborted();
    sessionLifecycle.markPromptSent();
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
    // UnavailableToolLoopDetector が閾値到達で発火した際に、その呼び出しが
    // 狙っていたツール名を残す。stale StructuredOutput recovery の対象判定
    // （呼ばれたツールが正確に StructuredOutput か）と、一般 unavailable-tool
    // recovery の対象判定（StructuredOutput 以外か）の両方に使う。
    let unavailableLoopToolName: string | undefined;
    let unavailableLoopServerTools: readonly string[] | undefined;
    let toolGuardFailure: ToolGuardRecoverableFailure | undefined;
    let idleConfirmed = false;
    const guardIngressState: GuardIngressState = {
      rawOffsets: new Map<string, number>(),
      partTypes: new Map<string, string>(),
      pendingPartDeltas: new Map<number, BufferedPartDelta>(),
      nextPartDeltaSequence: 0,
      nextPartDeltaSequenceToFlush: 0,
      pendingPartDeltaBytes: 0,
      pendingPartDeltaByteLimit: Math.max(
        guardSuite.policy.streamLimits.textByteLimit,
        guardSuite.policy.streamLimits.reasoningByteLimit,
      ),
      // delta は構造イベント数に入らないが、未確定中はイベント全体を保持する。
      // 構造イベントと同じ上限なら、payload のバイト上限とは別に要素 overhead も抑えられる。
      pendingPartDeltaCountLimit: guardSuite.policy.streamEventLimit,
      pendingPartDeltaLimitReason: guardSuite.policy.streamLimits.reasoningByteLimit
        >= guardSuite.policy.streamLimits.textByteLimit
        ? 'reasoning_bytes'
        : 'text_bytes',
      protocolFailure: undefined,
      echoState: { remainingPrompts: buildPromptEchoCandidates(promptText, options.systemPrompt) },
    };
    const textContentParts = new Map<string, string>();

    const consumeTextDelta = (partId: string, visibleDelta: string): void => {
      if (visibleDelta) {
        const redactor = state.textRedactors.get(partId) ?? createSensitiveTextStreamRedactor();
        state.textRedactors.set(partId, redactor);
        emitText(
          options.onStream,
          redactor.write(visibleDelta, state.sensitiveSources),
        );
        const previous = textContentParts.get(partId) ?? '';
        textContentParts.set(partId, `${previous}${visibleDelta}`);
      }
    };

    const consumeReasoningDelta = (partId: string, rawDelta: string): boolean => {
      if (!rawDelta) return true;
      if (!trackOpenCodeReasoningBytes(state, rawDelta)) return false;
      const fallbackRedactor = state.textRedactors.get(partId);
      if (fallbackRedactor !== undefined) {
        state.textRedactors.delete(partId);
        if (!state.thinkingRedactors.has(partId)) {
          state.thinkingRedactors.set(partId, fallbackRedactor);
        }
      }
      const redactor = state.thinkingRedactors.get(partId) ?? createSensitiveTextStreamRedactor();
      state.thinkingRedactors.set(partId, redactor);
      emitThinking(
        options.onStream,
        redactor.write(rawDelta, state.sensitiveSources),
      );
      const prevOffset = state.thinkingOffsets.get(partId) ?? 0;
      const nextOffset = prevOffset + rawDelta.length;
      state.thinkingOffsets.set(partId, nextOffset);
      return true;
    };

    // for-await 単体だと、タイマーが abort してもイベントが来るまで
    // 待ちから戻らない（SDK が signal を尊重しない場合は永久待機）。
    // イテレータと abort をレースさせ、タイマー発火で必ず脱出する。
    const streamIterator = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    const streamAborted = new Promise<never>((_, reject) => {
      streamAbortController.signal.addEventListener('abort', () => {
        const message = abortCause === 'deadline'
          ? guardSuite.getCallFailure()?.verdict.reason ?? OPENCODE_STREAM_ABORTED_MESSAGE
          : abortCause === 'timeout'
            ? timeoutMessage
            : OPENCODE_STREAM_ABORTED_MESSAGE;
        reject(new Error(message));
      }, { once: true });
    });
    streamAborted.catch(() => { /* race の敗者側での未処理拒否を防ぐ */ });

    let streamConsumptionError: unknown;
    const normalizedEventQueue: OpenCodeStreamEvent[] = [];
    try {
    while (true) {
      if (streamAbortController.signal.aborted) break;
      if (normalizedEventQueue.length === 0) {
        let iteration: IteratorResult<unknown>;
        try {
          iteration = await Promise.race([streamIterator.next(), streamAborted]);
          throwIfCallAborted();
        } catch (raceError) {
          if (streamAbortController.signal.aborted) break;
          throw raceError;
        }
        if (iteration.done) break;
        const rawEvent = iteration.value as OpenCodeStreamEvent;

        // active session への帰属を確認できないイベントは処理しない。
        // サーバプールは同一モデルで共有されるため（並列レビュー等）、
        // 兄弟セッションの text/tool 更新を通すと content と検出器が
        // 汚染される。帰属不明のイベントも状態変更や無音検出の延命には
        // 使わない。
        const eventSessionId = extractEventSessionId(rawEvent);
        if (eventSessionId !== activeSessionId) {
          continue;
        }
        normalizedEventQueue.push(
          ...normalizeGuardIngressEvent(rawEvent, activeSessionId, guardIngressState),
        );
        if (guardIngressState.protocolFailure !== undefined) {
          success = false;
          failureMessage = guardIngressState.protocolFailure;
          break;
        }
        if (normalizedEventQueue.length === 0) continue;
      }
      const sseEvent = normalizedEventQueue.shift();
      if (sseEvent === undefined) continue;
      const guardResult = guardSuite.onEvent(sseEvent);
      for (const anomaly of guardResult.anomalies) {
        log.warn(anomaly.verdict.reason, { sessionId: activeSessionId, guardId: anomaly.guardId });
      }
      if (guardResult.failure !== undefined) {
        success = false;
        failureMessage = guardResult.failure.verdict.reason;
        const recoveryFailure = guardResult.failure.recoveryFailure;
        if (recoveryFailure !== undefined) {
          const part = sseEvent.type === 'message.part.updated'
            ? sseEvent.properties.part as OpenCodePart
            : undefined;
          const toolPart = part?.type === 'tool' ? part as OpenCodeToolPart : undefined;
          toolGuardFailure = toolPart === undefined
            ? recoveryFailure
            : sanitizeToolGuardFailure(recoveryFailure, toolPart.tool, toolPart.state.input);
          failureMessage = toolGuardFailure.message;
          if (toolGuardFailure.kind === 'unavailable_tool_loop') {
            unavailableLoopToolName = toolGuardFailure.tool;
            unavailableLoopServerTools = parseServerAvailableTools(toolGuardFailure.message);
          }
        }
        diag.onStreamError(sseEvent.type, failureMessage);
        break;
      }
      diag.onFirstEvent(sseEvent.type);
      diag.onEvent(sseEvent.type);
      if (sseEvent.type === 'message.part.updated') {
        const props = sseEvent.properties as { part: OpenCodePart; delta?: string };
        const part = props.part;
        const delta = props.delta;

        if (part.type === 'text') {
          const textPart = part as OpenCodeTextPart;
          consumeTextDelta(textPart.id, delta ?? textPart.text);
          continue;
        }

        if (part.type === 'reasoning') {
          const reasoningPart = part as {
            id: string;
            text: string;
          };
          const reasoningDelta = delta
            ?? reasoningPart.text.slice(state.thinkingOffsets.get(reasoningPart.id) ?? 0);
          if (!consumeReasoningDelta(reasoningPart.id, reasoningDelta)) {
            success = false;
            failureMessage = describeOpenCodeStreamTrackingLimitFailure(state.trackingLimitReason);
            diag.onStreamError(sseEvent.type, failureMessage);
            break;
          }
          continue;
        }

        if (part.type === 'tool') {
          const toolPart = part as OpenCodeToolPart;
          const rejection = extractOpenCodeToolRejection(toolPart);
          // onStream（→ provider event logging 有効時は *-provider-events.jsonl
          // へ永続化される）にも raw エラー文を流さない。マスク済みの
          // コピーを downstream へ渡す（onStream はライブ表示専用ではなく
          // 永続化経路を含む）。
          let partForDownstream: OpenCodePart = part;
          if (rejection !== undefined) {
            // 失敗したツール呼び出しの引数を残す。エラー文だけでは
            // モデルが何をどう間違えたか（スキーマ違反の該当欄、
            // 幻覚パス、ツール本文の不一致）を後から特定できない。
            // input/error は無加工では機密情報が残り得るためマスクする。
            // エラー文は先に共通sanitizerが定義するツール本文の実値を除去し、
            // 以後 downstream にはマスク済みの文字列だけを流す。
            const maskedError = sanitizeSensitiveTextWithKnownValues(
              maskOpenCodeToolContentInText(rejection.error, toolPart.tool, toolPart.state.input),
              toolPart.state.input,
            );
            if (toolPart.state.status === 'error') {
              partForDownstream = {
                ...toolPart,
                state: { ...toolPart.state, error: maskedError },
              } as OpenCodePart;
            }
            log.debug('OpenCode tool call failed', {
              tool: rejection.tool,
              callId: toolPart.callID || toolPart.id,
              error: sanitizeSensitiveText(maskedError),
              input: sanitizeToolCallInputForLogging(toolPart.tool, toolPart.state.input),
            });
          }
          if (!handlePartUpdated(partForDownstream, delta, options.onStream, state)) {
            success = false;
            failureMessage = describeOpenCodeStreamTrackingLimitFailure(state.trackingLimitReason);
            diag.onStreamError(sseEvent.type, failureMessage);
            break;
          }
          continue;
        }

        if (!handlePartUpdated(part, delta, options.onStream, state)) {
          success = false;
          failureMessage = describeOpenCodeStreamTrackingLimitFailure(state.trackingLimitReason);
          diag.onStreamError(sseEvent.type, failureMessage);
          break;
        }
        continue;
      }

      if (sseEvent.type === 'message.part.delta') {
        const deltaProps = sseEvent.properties as {
          sessionID: string;
          partID: string;
          field: string;
          delta: string;
          guardPartType?: string;
        };
        if (deltaProps.field === 'text' && deltaProps.delta) {
          const partType = deltaProps.guardPartType;
          if (partType === 'reasoning') {
            if (!consumeReasoningDelta(deltaProps.partID, deltaProps.delta)) {
              success = false;
              failureMessage = describeOpenCodeStreamTrackingLimitFailure(state.trackingLimitReason);
              diag.onStreamError(sseEvent.type, failureMessage);
              break;
            }
          } else if (partType === 'text' || partType === undefined) {
            consumeTextDelta(deltaProps.partID, deltaProps.delta);
          }
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
            throwIfCallAborted();
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
              options.abortSignal,
            );
            throwIfCallAborted();
            if (reply === 'reject') {
              // A rejected permission is a per-tool failure, not a fatal
              // one: OpenCode returns the rejection to the model as a tool
              // error and generation continues (verified against a live
              // server). Aborting here used to turn a single stray
              // out-of-workspace access into a whole-step failure.
              log.info(
                sanitizeSensitiveText(buildPermissionRejectedMessage(permProps.permission)),
                sanitizeSensitiveValue({
                  permission: permProps.permission,
                  patterns: permProps.patterns,
                  always: permProps.always,
                }),
              );
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
              options.abortSignal,
            );

          if (!options.onAskUserQuestion) {
            try {
              throwIfCallAborted();
              await rejectQuestion();
              throwIfCallAborted();
            } catch (e) {
              success = false;
              failureMessage = getErrorMessage(e);
              break;
            }
            continue;
          }

          try {
            throwIfCallAborted();
            const answers = await withAbortSignal(
              options.onAskUserQuestion(toQuestionInput(questionProps)),
              options.abortSignal,
            );
            throwIfCallAborted();
            await withTimeout(
              (signal) => opencodeApiClient!.question.reply({
                requestID: questionProps.id,
                directory: options.cwd,
                answers: toQuestionAnswers(questionProps, answers),
              }, { signal }),
              interactionTimeoutMs,
              'OpenCode question reply timed out',
              options.abortSignal,
            );
            throwIfCallAborted();
          } catch (e) {
            if (e instanceof AskUserQuestionDeniedError) {
              try {
                throwIfCallAborted();
                await rejectQuestion();
                throwIfCallAborted();
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
            diag.onStreamError('message.updated', sanitizeAttemptError(streamError));
            break;
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
            diag.onStreamError('message.completed', sanitizeAttemptError(streamError));
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
          diag.onStreamError('message.failed', sanitizeAttemptError(failureMessage));
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
          idleConfirmed = true;
          sessionLifecycle.confirmIdle();
          break;
        }
        continue;
      }

      if (sseEvent.type === 'session.idle') {
        const idleProps = sseEvent.properties as { sessionID: string };
        if (idleProps.sessionID === activeSessionId) {
          idleConfirmed = true;
          sessionLifecycle.confirmIdle();
          break;
        }
        continue;
      }

      if (sseEvent.type === 'session.error') {
        const errorProps = sseEvent.properties as {
          sessionID?: string;
          error?: unknown;
        };
        if (errorProps.sessionID === activeSessionId) {
          success = false;
          failureMessage = extractOpenCodeErrorMessage(errorProps.error) ?? 'OpenCode session error';
          diag.onStreamError('session.error', sanitizeAttemptError(failureMessage));
          break;
        }
        continue;
      }
    }
    } catch (error) {
      streamConsumptionError = error;
    }
    let streamCloseError: unknown;
    try {
      if (streamIterator.return !== undefined) {
        await withTimeout(
          () => streamIterator.return!(undefined).then(() => undefined),
          OPENCODE_SESSION_ABORT_TIMEOUT_MS,
          'OpenCode stream iterator close timed out',
          options.abortSignal,
        );
      }
    } catch (error) {
      streamCloseError = error;
    }
    if (streamConsumptionError !== undefined && streamCloseError !== undefined) {
      throw new AggregateError(
        [streamConsumptionError, streamCloseError],
        'OpenCode stream consumption and cleanup failed',
      );
    }
    if (streamConsumptionError !== undefined) {
      throw streamConsumptionError;
    }
    if (streamCloseError !== undefined) {
      throw streamCloseError;
    }

    throwIfServerInvalidated();

    // Guard-triggered and external aborts cancel the stream. If the
    // iterator ends without throwing, the loop falls through with
    // success still true - do not let a timed-out or aborted stream
    // pass as a completed call (a stalled stream after a rejected
    // permission would otherwise be reported as done).
    if (
      success
      && streamAbortController.signal.aborted
      && (abortCause === 'timeout' || abortCause === 'deadline' || abortCause === 'external')
    ) {
      success = false;
      failureMessage = abortCause === 'timeout'
        ? timeoutMessage
        : abortCause === 'deadline'
          ? guardSuite.getCallFailure()?.verdict.reason ?? OPENCODE_STREAM_ABORTED_MESSAGE
          : OPENCODE_STREAM_ABORTED_MESSAGE;
    }

    if (success && guardIngressState.pendingPartDeltas.size > 0) {
      success = false;
      failureMessage = 'OpenCode stream protocol failure: unresolved part type for buffered text delta';
    }

    if (success && !idleConfirmed) {
      success = false;
      failureMessage = 'OpenCode stream ended before the session became idle';
    }

    content = [...textContentParts.values()].join('\n');
    if (!success && !streamAbortController.signal.aborted) {
      streamAbortController.abort();
    }
    await awaitPromptCompletion();
    throwIfCallAborted();
    throwIfServerInvalidated();
    if (promptError !== undefined) {
      if (success || abortCause === 'prompt') {
        success = false;
        failureMessage = promptError;
      } else if (!failureMessage) {
        failureMessage = promptError;
      }
    }
    pendingCompletion = {
      reason: success ? 'normal' : 'error',
      ...(success ? {} : { detail: sanitizeAttemptError(failureMessage) }),
    };

    if (!success) {
      let message = failureMessage || 'OpenCode execution failed';
      const stopResult = await sessionLifecycle.stopServerSessionOnce();
      throwIfCallAborted();
      throwIfServerInvalidated();
      if (!stopResult.ok) {
        message = stopResult.error.message;
        const sanitizedMessage = sanitizeAttemptError(message);
        scheduleResultEmission(false, sanitizedMessage, activeSessionId);
        throwIfServerInvalidated();
        return {
          persona: agentType,
          status: 'error',
          content: sanitizedMessage,
          error: sanitizedMessage,
          timestamp: new Date(),
          sessionId: activeSessionId,
          ...(attempt > 1 ? { retryCount: attempt - 1 } : {}),
        };
      }
      // 認証済み transport の無音タイムアウトで止めた場合、死因はサーバが握った
      // 429 かもしれない。
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
          options.abortSignal,
        );
        throwIfCallAborted();
        throwIfServerInvalidated();
        if (rateLimitMessage !== undefined) {
          // プロバイダ由来の生エラー文はリクエスト内容やアカウント情報を
          // 含みうるため、分類済みの事実だけを永続化する。
          log.warn('OpenCode stream stalled on a provider rate limit', {
            sessionId: activeSessionId,
            model: options.model,
          });
          // 検死で 429 と確定済み。message 文字列に 429 の語が含まれるとは
          // 限らない（statusCode だけで判定した場合）ため再判定はしない。
          const rateLimitedResponse = this.buildRateLimitedResponse(
            agentType,
            activeSessionId,
            sanitizeAttemptError(rateLimitMessage),
            attempt - 1,
          );
          scheduleResultEmission(
            false,
            rateLimitedResponse.error ?? rateLimitedResponse.content,
            activeSessionId,
          );
          throwIfServerInvalidated();
          return rateLimitedResponse;
        }
      }
      if (containsRateLimitError(message)) {
        const rateLimitedResponse = this.buildRateLimitedResponse(
          agentType,
          activeSessionId,
          sanitizeAttemptError(message),
          attempt - 1,
        );
        scheduleResultEmission(false, rateLimitedResponse.error ?? rateLimitedResponse.content, activeSessionId);
        throwIfServerInvalidated();
        return rateLimitedResponse;
      }
      // Failures that point at the native json_schema request itself: a
      // model that never emits the StructuredOutput tool ("did not produce
      // structured output"), or a gateway/model that rejects the json_schema
      // response format outright (surfaced as an upstream request error).
      // These fall back to formatless structured output in a fresh session —
      // resuming the same session would let the model keep "remembering" the
      // native tool it just failed to use. Generic transient errors
      // (transport/network) must not trigger this, or they would burn the
      // one-shot fallback budget before a real format failure arrives.
      if (shouldDegradeToFormatless(callState.recoveryState, message)) {
        throwIfCallAborted();
        callState.recoveryState = degradeToFormatless(callState.recoveryState);
        callState.maxAttempts = Math.max(callState.maxAttempts, attempt + 1);
        log.debug('OpenCode native structured output failed; degrading to formatless prompt in a fresh session', {
          agentType,
          previousAttempt: attempt,
          previousSessionId: activeSessionId,
          message: sanitizeAttemptError(message),
        });
        await this.waitForRetryDelay(attempt, options.abortSignal);
        throwIfCallAborted();
        throwIfServerInvalidated();
        return RETRY_ATTEMPT;
      }

      // A resumed session can carry native StructuredOutput success history
      // from an earlier (unrelated) step. When this attempt does not request
      // structured output at all (plain) but the model still calls the now-
      // unavailable StructuredOutput tool until the loop detector fires,
      // that is stale session memory, not a real failure of this request —
      // retry the same prompt once in a fresh session instead of failing
      // the step outright.
      if (shouldRecoverStaleSession(callState.recoveryState, attemptPlan, unavailableLoopToolName)) {
        throwIfCallAborted();
        callState.recoveryState = recoverStaleSession(callState.recoveryState);
        callState.maxAttempts = Math.max(callState.maxAttempts, attempt + 1);
        log.debug('OpenCode resumed session called a stale StructuredOutput tool; retrying prompt in a fresh session', {
          agentType,
          previousAttempt: attempt,
          previousSessionId: activeSessionId,
          tool: unavailableLoopToolName,
        });
        await this.waitForRetryDelay(attempt, options.abortSignal);
        throwIfCallAborted();
        throwIfServerInvalidated();
        return RETRY_ATTEMPT;
      }

      const recoverableToolFailure = toolGuardFailure?.kind === 'unavailable_tool_loop'
        && toolGuardFailure.tool === STRUCTURED_OUTPUT_TOOL_NAME
        ? undefined
        : toolGuardFailure;
      if (recoverableToolFailure !== undefined) {
        const toolGuardRecoveryAction = resolveToolGuardRecoveryAction(
          callState.toolGuardRecovery,
          getToolGuardFailureFingerprint(recoverableToolFailure),
        );
        if (toolGuardRecoveryAction === 'correction') {
          throwIfCallAborted();
          callState.toolGuardRecovery = markToolGuardCorrectionPending(
            callState.toolGuardRecovery,
            activeSessionId,
            getToolGuardFailureFingerprint(recoverableToolFailure),
            buildToolGuardCorrectionPrompt(recoverableToolFailure, unavailableLoopServerTools),
          );
          guardSuite.noteRecovery();
          callState.maxAttempts = Math.max(callState.maxAttempts, attempt + 1);
          log.debug('OpenCode tool loop detected; sending one in-session correction', {
            agentType,
            previousAttempt: attempt,
            sessionId: activeSessionId,
            kind: recoverableToolFailure.kind,
            fingerprint: getToolGuardFailureFingerprint(recoverableToolFailure).slice(0, 12),
            toolHealth: guardSuite.stats(),
          });
          await this.waitForRetryDelay(attempt, options.abortSignal);
          throwIfCallAborted();
          throwIfServerInvalidated();
          return RETRY_ATTEMPT;
        }

        if (toolGuardRecoveryAction === 'fresh_session') {
          throwIfCallAborted();
          callState.toolGuardRecovery = markToolGuardFreshSessionUsed(callState.toolGuardRecovery, recoverableToolFailure.kind);
          guardSuite.noteRecovery();
          callState.maxAttempts = Math.max(callState.maxAttempts, attempt + 1);
          log.debug('OpenCode tool guard failure; retrying prompt once in a fresh session with a continuation preamble', {
            agentType,
            previousAttempt: attempt,
            previousSessionId: activeSessionId,
            reason: recoverableToolFailure.kind,
            toolHealth: guardSuite.stats(),
          });
          await this.waitForRetryDelay(attempt, options.abortSignal);
          throwIfCallAborted();
          throwIfServerInvalidated();
          return RETRY_ATTEMPT;
        }
      }

      // ガード発火（absolute_cost_limit / recovery 消費後の再発）は決定的な
      // ループ失敗であり transient ではない — retriable 判定に流さず即失敗する。
      // needs_fix / plan への自動迂回はしない（インフラ障害とレビュー判断を
      // 混同しない。
      const retriable = toolGuardFailure === undefined
        && this.isRetriableError(message, abortCause);
      if (retriable && attempt < OPENCODE_RETRY_MAX_ATTEMPTS) {
        throwIfCallAborted();
        log.info('Retrying OpenCode call after transient failure', {
          agentType,
          attempt,
          message: sanitizeAttemptError(message),
        });
        await this.waitForRetryDelay(attempt, options.abortSignal);
        throwIfCallAborted();
        throwIfServerInvalidated();
        return RETRY_ATTEMPT;
      }

      if (callState.recoveryState.nativeDegraded || callState.recoveryState.staleSessionRecoveryUsed || callState.toolGuardRecovery.freshSessionUsed) {
        log.debug('OpenCode recovery attempt finished', {
          agentType,
          attempt,
          sessionId: activeSessionId,
          nativeDegraded: callState.recoveryState.nativeDegraded,
          staleSessionRecoveryUsed: callState.recoveryState.staleSessionRecoveryUsed,
          toolGuardFreshSessionUsed: callState.toolGuardRecovery.freshSessionUsed,
          outcome: 'error',
          message: sanitizeAttemptError(message),
        });
      }

      // 観測: 閾値校正の材料として tool health を構造化して残す
      // （debug ログ + AgentResponse.debugInfo）。
      const failureToolHealth = guardSuite.stats();
      log.debug('OpenCode tool health at failure', { agentType, ...failureToolHealth });
      throwIfCallAborted();
      throwIfServerInvalidated();
      const sanitizedMessage = sanitizeAttemptError(message);
      scheduleResultEmission(false, sanitizedMessage, activeSessionId);
      throwIfServerInvalidated();
      return {
        persona: agentType,
        status: 'error',
        content: sanitizedMessage,
        error: sanitizedMessage,
        timestamp: new Date(),
        sessionId: activeSessionId,
        debugInfo: { toolHealth: failureToolHealth },
        ...(attempt > 1 ? { retryCount: attempt - 1 } : {}),
      };
    }

    if (callState.recoveryState.nativeDegraded || callState.recoveryState.staleSessionRecoveryUsed || callState.toolGuardRecovery.freshSessionUsed) {
      log.debug('OpenCode recovery attempt finished', {
        agentType,
        attempt,
        sessionId: activeSessionId,
        nativeDegraded: callState.recoveryState.nativeDegraded,
        staleSessionRecoveryUsed: callState.recoveryState.staleSessionRecoveryUsed,
        toolGuardFreshSessionUsed: callState.toolGuardRecovery.freshSessionUsed,
        outcome: 'success',
      });
    }

    const trimmed = content.trim();

    // format 要求時に structured がイベントで捕捉できなかった場合は、
    // 応答全体のJSON object、または従来のfenced JSONを採取する（検証は下流で行う）。
    if (capturedStructuredOutput === undefined && options.outputSchema !== undefined) {
      try {
        capturedStructuredOutput = parseStructuredOutputObject(trimmed);
      } catch (fallbackError) {
        // フォールバック採取の失敗は握りつぶすが、調査用に痕跡は残す
        // （下流の検証と是正リトライに委ねる）。
        log.debug('Structured output fallback extraction failed', {
          agentType,
          error: sanitizeAttemptError(getErrorMessage(fallbackError)),
        });
      }
    }

    // 観測: 成功時も tool health を残す（v3-r4 のような「生産的だが edit 税を
    // 払っている」走行の分布を校正データとして採取するため）。
    const successToolHealth = guardSuite.stats();
    if (successToolHealth.totalErrors > 0) {
      log.debug('OpenCode tool health at success', { agentType, ...successToolHealth });
    }
    throwIfCallAborted();
    throwIfServerInvalidated();
    scheduleResultEmission(true, trimmed, activeSessionId);
    throwIfServerInvalidated();
    return {
      persona: agentType,
      status: 'done',
      content: trimmed,
      timestamp: new Date(),
      sessionId: activeSessionId,
      ...(capturedStructuredOutput !== undefined ? { structuredOutput: capturedStructuredOutput } : {}),
      debugInfo: { toolHealth: successToolHealth },
      ...(attempt > 1 ? { retryCount: attempt - 1 } : {}),
    };
  } catch (error) {
    const invalidationError = currentServerInvalidationError()
      ?? (error instanceof OpenCodeSharedServerInvalidationError ? error : undefined);
    if (invalidationError !== undefined) {
      serverInvalidationError ??= invalidationError;
      return buildServerInvalidationResponse(invalidationError);
    }

    const message = getErrorMessage(error);
    let errorMessage = streamAbortController.signal.aborted
      ? abortCause === 'timeout'
        ? timeoutMessage
        : abortCause === 'deadline'
          ? guardSuite.getCallFailure()?.verdict.reason ?? OPENCODE_STREAM_ABORTED_MESSAGE
        : abortCause === 'prompt' && promptError !== undefined
          ? promptError
          : OPENCODE_STREAM_ABORTED_MESSAGE
      : message;

    const stopResult = await sessionLifecycle?.stopServerSessionOnce();
    const invalidationAfterStop = currentServerInvalidationError();
    if (stopResult !== undefined && !stopResult.ok) {
      attemptCleanupError = combineAttemptAndCleanupErrors(error, stopResult.error);
      errorMessage = attemptCleanupError.message;
    } else if (invalidationAfterStop !== undefined) {
      attemptCleanupError = combineAttemptAndCleanupErrors(error, invalidationAfterStop);
      errorMessage = attemptCleanupError.message;
    }
    if (invalidationAfterStop !== undefined) {
      return buildAttemptErrorResponse(errorMessage);
    }

    if (containsRateLimitError(errorMessage)) {
      const rateLimitedResponse = this.buildRateLimitedResponse(
        agentType,
        sessionId,
        sanitizeAttemptError(errorMessage),
        attempt - 1,
      );
      if (sessionId) {
        scheduleResultEmission(false, rateLimitedResponse.error ?? rateLimitedResponse.content, sessionId);
      }
      const invalidationAfterRateLimitEmit = currentServerInvalidationError();
      if (invalidationAfterRateLimitEmit !== undefined) {
        return buildServerInvalidationResponse(invalidationAfterRateLimitEmit);
      }
      return rateLimitedResponse;
    }

    pendingCompletion = {
      reason: abortCause === 'timeout'
        ? 'timeout'
        : streamAbortController.signal.aborted && abortCause !== 'prompt'
          ? 'abort'
          : 'error',
      detail: sanitizeAttemptError(errorMessage),
    };

    const retriable = (stopResult === undefined || stopResult.ok)
      && this.isRetriableError(errorMessage, abortCause);
    if (retriable && attempt < OPENCODE_RETRY_MAX_ATTEMPTS) {
      throwIfCallAborted();
      log.info('Retrying OpenCode call after transient exception', {
        agentType,
        attempt,
        errorMessage: sanitizeAttemptError(errorMessage),
      });
      await this.waitForRetryDelay(attempt, options.abortSignal);
      throwIfCallAborted();
      const invalidationAfterRetryDelay = currentServerInvalidationError();
      if (invalidationAfterRetryDelay !== undefined) {
        return buildServerInvalidationResponse(invalidationAfterRetryDelay);
      }
      return RETRY_ATTEMPT;
    }

    if (sessionId) {
      scheduleResultEmission(false, sanitizeAttemptError(errorMessage), sessionId);
    }
    const invalidationBeforeErrorReturn = currentServerInvalidationError();
    if (invalidationBeforeErrorReturn !== undefined) {
      return buildServerInvalidationResponse(invalidationBeforeErrorReturn);
    }

    const sanitizedErrorMessage = sanitizeAttemptError(errorMessage);
    const failureCategory = resolveOpenCodeAbortFailureCategory(abortCause);
    return {
      persona: agentType,
      status: 'error',
      content: sanitizedErrorMessage,
      error: sanitizedErrorMessage,
      timestamp: new Date(),
      sessionId,
      ...(failureCategory === undefined ? {} : { failureCategory }),
      ...(attempt > 1 ? { retryCount: attempt - 1 } : {}),
    };
  } finally {
    guardSuite.stopAttempt();
    if (options.abortSignal) {
      options.abortSignal.removeEventListener('abort', onExternalAbort);
    }
    if (!streamAbortController.signal.aborted) {
      streamAbortController.abort();
    }
    await awaitPromptCompletion();
    const stopResult = serverInvalidationError === undefined
      ? await sessionLifecycle?.stopServerSessionOnce()
      : undefined;
    if (stopResult !== undefined && !stopResult.ok) {
      log.warn('OpenCode server session could not be stopped; shared server invalidated', {
        sessionId,
        error: sanitizeAttemptError(stopResult.error.message),
      });
    }
    const invalidationAfterCleanup = currentServerInvalidationError();
    finalizationInvalidationError = invalidationAfterCleanup;
  }
    })();

    // lease を譲渡する前に、最後の invalidation 確認と観測可能な結果を確定する。
    const callAbortError = options.abortSignal?.aborted
      ? new Error(guardSuite.getCallFailure()?.verdict.reason ?? OPENCODE_STREAM_ABORTED_MESSAGE)
      : undefined;
    const finalizationError = callAbortError
      ?? attemptCleanupError
      ?? currentServerInvalidationError()
      ?? finalizationInvalidationError;
    if (finalizationError !== undefined) {
      attemptResult = buildAttemptErrorResponse(finalizationError);
      const finalizationMessage = attemptResult.error ?? attemptResult.content;
      pendingCompletion = {
        reason: 'error',
        detail: finalizationMessage,
      };
      if (attemptResult.sessionId) {
        scheduleResultEmission(
          false,
          attemptResult.error ?? attemptResult.content,
          attemptResult.sessionId,
        );
      }
    }
    if (pendingCompletion !== undefined) {
      diagRef?.onCompleted(pendingCompletion.reason, pendingCompletion.detail);
    }
    if (!options.abortSignal?.aborted) {
      flushSensitiveTextStreams(options.onStream, state);
    }
    if (!options.abortSignal?.aborted && pendingResultEmission !== undefined) {
      emitResult(
        options.onStream,
        pendingResultEmission.success,
        pendingResultEmission.content,
        pendingResultEmission.sessionId,
        state.sensitiveSources,
      );
    }
    return attemptResult;
  } finally {
    removeServerInvalidationListener?.();
    release?.();
    try {
      await options.preparedMcp?.dispose?.();
    } catch (error) {
      log.debug('Failed to clean up OpenCode MCP config', { error: getErrorMessage(error) });
    }
  }
  }
  async compactSession(options: OpenCodeCompactSessionOptions): Promise<void> {
    await compactOpenCodeSessionWithCoordinator(options);
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
