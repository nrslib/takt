/**
 * OpenCode stream event handling.
 *
 * Converts OpenCode SDK SSE events into the unified StreamCallback format
 * used throughout the takt codebase.
 */

import type { StreamCallback } from '../../shared/types/provider.js';
import {
  createSensitiveTextStreamRedactor,
  createBoundedSensitiveValues,
  type BoundedSensitiveValues,
  sanitizeSensitiveTextWithKnownValues,
  sanitizeSensitiveValue,
  type SensitiveTextStreamRedactor,
} from '../../shared/utils/sensitiveText.js';
import {
  maskOpenCodeToolContentInText,
  sanitizeOpenCodeToolInput,
} from './tool-input-sanitizer.js';
import { computeToolInputHash } from './tool-call-tuple.js';

/** Subset of OpenCode Part types relevant for stream handling */
export interface OpenCodeTextPart {
  id: string;
  sessionID: string;
  type: 'text';
  text: string;
}

export interface OpenCodeReasoningPart {
  id: string;
  sessionID: string;
  type: 'reasoning';
  text: string;
}

export interface OpenCodeToolPart {
  id: string;
  sessionID: string;
  type: 'tool';
  callID: string;
  tool: string;
  state: OpenCodeToolState;
}

export type OpenCodeToolState =
  | { status: 'pending'; input: Record<string, unknown> }
  | { status: 'running'; input: Record<string, unknown>; title?: string }
  | {
    status: 'completed';
    input: Record<string, unknown>;
    output: string;
    title: string;
    metadata?: Record<string, unknown>;
  }
  | { status: 'error'; input: Record<string, unknown>; error: string };

export type OpenCodePart = OpenCodeTextPart | OpenCodeReasoningPart | OpenCodeToolPart | { id: string; type: string; sessionID?: string };

export type OpenCodeStreamTrackingLimitReason =
  | 'event_count'
  | 'tracked_id_count'
  | 'text_bytes'
  | 'reasoning_bytes'
  | 'sensitive_sources';

/** OpenCode SSE event types relevant for stream handling */
export interface OpenCodeMessagePartUpdatedEvent {
  type: 'message.part.updated';
  properties: { part: OpenCodePart; delta?: string };
}

export interface OpenCodeSessionIdleEvent {
  type: 'session.idle';
  properties: { sessionID: string };
}

export interface OpenCodeSessionStatusEvent {
  type: 'session.status';
  properties: {
    sessionID: string;
    status: { type: 'idle' | 'busy' | 'retry'; attempt?: number; message?: string; next?: number };
  };
}

export interface OpenCodeSessionErrorEvent {
  type: 'session.error';
  properties: {
    sessionID?: string;
    error?: { name: string; data: { message: string } };
  };
}

export interface OpenCodeMessageUpdatedEvent {
  type: 'message.updated';
  properties: {
    info: {
      sessionID: string;
      role: 'assistant' | 'user';
      time?: { created?: number; completed?: number };
      error?: unknown;
    };
  };
}

export interface OpenCodeMessageCompletedEvent {
  type: 'message.completed';
  properties: {
    info: {
      sessionID: string;
      role: 'assistant' | 'user';
      error?: unknown;
    };
  };
}

export interface OpenCodeMessageFailedEvent {
  type: 'message.failed';
  properties: {
    info: {
      sessionID: string;
      role: 'assistant' | 'user';
      error?: unknown;
    };
  };
}

export interface OpenCodePermissionAskedEvent {
  type: 'permission.asked';
  properties: {
    id: string;
    sessionID: string;
    permission: string;
    patterns: string[];
    metadata: Record<string, unknown>;
    always: string[];
  };
}

export interface OpenCodeQuestionAskedEvent {
  type: 'question.asked';
  properties: {
    id: string;
    sessionID: string;
    questions: Array<{
      question: string;
      header: string;
      options: Array<{
        label: string;
        description: string;
      }>;
      multiple?: boolean;
    }>;
  };
}

export type OpenCodeStreamEvent =
  | OpenCodeMessagePartUpdatedEvent
  | OpenCodeMessageUpdatedEvent
  | OpenCodeMessageCompletedEvent
  | OpenCodeMessageFailedEvent
  | OpenCodeSessionStatusEvent
  | OpenCodeSessionIdleEvent
  | OpenCodeSessionErrorEvent
  | OpenCodePermissionAskedEvent
  | OpenCodeQuestionAskedEvent
  | { type: string; properties: Record<string, unknown> };

/** Volume/memory limits applied to a single attempt's stream tracking. */
export interface OpenCodeStreamLimits {
  /** 可視テキスト累計バイト上限。 */
  textByteLimit: number;
  /** reasoning 累計バイト上限。 */
  reasoningByteLimit: number;
  /** 追跡する part/tool ID 数の上限（メモリ有界化）。 */
  idLimit: number;
}

/** Tracking state for stream offsets during a single OpenCode session */
export interface StreamTrackingState {
  textOffsets: Map<string, number>;
  thinkingOffsets: Map<string, number>;
  textRedactors: Map<string, SensitiveTextStreamRedactor>;
  thinkingRedactors: Map<string, SensitiveTextStreamRedactor>;
  partTypes: Map<string, string>;
  startedTools: Set<string>;
  latestToolInputHashes: Map<string, string>;
  sensitiveSources: BoundedSensitiveValues;
  eventCount: number;
  textBytes: number;
  reasoningBytes: number;
  trackedIds: Set<string>;
  limits: OpenCodeStreamLimits;
  trackingLimitReason?: OpenCodeStreamTrackingLimitReason;
  exhausted: boolean;
}

export const OPENCODE_STREAM_EVENT_LIMIT = 10_000;
export const OPENCODE_STREAM_ID_LIMIT = 8_192;
// 健全な implement 実行の実測は text 65.5KB / reasoning 28.4KB（13分・3.5分）。
// この上限は劣化検出器ではなく「どう考えても異常な量」を止めるバックストップ
// なので、実測から1桁以上離した値に置く。誤爆した旧値 64KiB の反省を維持する
// こと — 正常系の実測と同じ桁に上限を置いてはならない。
export const OPENCODE_STREAM_TEXT_BYTE_LIMIT = 1024 * 1024;
export const OPENCODE_STREAM_REASONING_BYTE_LIMIT = 4 * 1024 * 1024;
export const OPENCODE_STREAM_TRACKING_LIMIT_MESSAGE = 'OpenCode stream tracking limit exceeded';

function resolveLimitEnvInt(name: string, fallback: number): number {
  const fromEnv = Number(process.env[name]);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : fallback;
}

/**
 * 呼び出し時に評価する。優先順位は既存 provider_options 機構と同じで
 * env > config（env は実験・テスト用の一時上書き、運用調整は config/persona）。
 * 容量上限は profile では切れない（有界資源層）。
 */
export function resolveOpenCodeStreamLimits(
  guards?: { textByteLimit?: number; reasoningByteLimit?: number },
): OpenCodeStreamLimits {
  return {
    textByteLimit: resolveLimitEnvInt(
      'TAKT_OPENCODE_STREAM_TEXT_BYTE_LIMIT',
      guards?.textByteLimit ?? OPENCODE_STREAM_TEXT_BYTE_LIMIT,
    ),
    reasoningByteLimit: resolveLimitEnvInt(
      'TAKT_OPENCODE_STREAM_REASONING_BYTE_LIMIT',
      guards?.reasoningByteLimit ?? OPENCODE_STREAM_REASONING_BYTE_LIMIT,
    ),
    idLimit: resolveLimitEnvInt('TAKT_OPENCODE_STREAM_ID_LIMIT', OPENCODE_STREAM_ID_LIMIT),
  };
}

export function createStreamTrackingState(
  limits?: OpenCodeStreamLimits,
  sensitiveSources?: BoundedSensitiveValues,
): StreamTrackingState {
  return {
    textOffsets: new Map<string, number>(),
    thinkingOffsets: new Map<string, number>(),
    textRedactors: new Map<string, SensitiveTextStreamRedactor>(),
    thinkingRedactors: new Map<string, SensitiveTextStreamRedactor>(),
    partTypes: new Map<string, string>(),
    startedTools: new Set<string>(),
    latestToolInputHashes: new Map<string, string>(),
    sensitiveSources: sensitiveSources ?? createBoundedSensitiveValues(),
    eventCount: 0,
    textBytes: 0,
    reasoningBytes: 0,
    trackedIds: new Set<string>(),
    limits: limits ?? resolveOpenCodeStreamLimits(),
    trackingLimitReason: undefined,
    exhausted: false,
  };
}

export function trackOpenCodeTextBytes(state: StreamTrackingState, text: string): boolean {
  if (state.exhausted) {
    return false;
  }
  const nextTextBytes = state.textBytes + Buffer.byteLength(text, 'utf8');
  if (nextTextBytes > state.limits.textByteLimit) {
    exhaustStreamTrackingState(state, 'text_bytes');
    return false;
  }
  state.textBytes = nextTextBytes;
  return true;
}

export function trackOpenCodeReasoningBytes(state: StreamTrackingState, text: string): boolean {
  if (state.exhausted) {
    return false;
  }
  const nextReasoningBytes = state.reasoningBytes + Buffer.byteLength(text, 'utf8');
  if (nextReasoningBytes > state.limits.reasoningByteLimit) {
    exhaustStreamTrackingState(state, 'reasoning_bytes');
    return false;
  }
  state.reasoningBytes = nextReasoningBytes;
  return true;
}

function exhaustStreamTrackingState(
  state: StreamTrackingState,
  reason?: OpenCodeStreamTrackingLimitReason,
): void {
  if (reason !== undefined && state.trackingLimitReason === undefined) {
    state.trackingLimitReason = reason;
  }
  state.textOffsets.clear();
  state.thinkingOffsets.clear();
  state.textRedactors.clear();
  state.thinkingRedactors.clear();
  state.partTypes.clear();
  state.startedTools.clear();
  state.latestToolInputHashes.clear();
  state.trackedIds.clear();
  state.sensitiveSources.exhaust();
  state.exhausted = true;
}

function trackStreamId(state: StreamTrackingState, id: string): boolean {
  if (state.exhausted) {
    return false;
  }
  if (state.trackedIds.has(id)) {
    return true;
  }
  if (state.trackedIds.size >= state.limits.idLimit) {
    exhaustStreamTrackingState(state, 'tracked_id_count');
    return false;
  }
  state.trackedIds.add(id);
  return true;
}

function rememberPartType(state: StreamTrackingState, part: OpenCodePart): void {
  const partId = part.type === 'tool'
    ? ((part as OpenCodeToolPart).callID || part.id)
    : part.id;
  state.partTypes.set(partId, part.type);
}

export function describeOpenCodeStreamTrackingLimitFailure(
  reason: OpenCodeStreamTrackingLimitReason | undefined,
): string {
  return reason === undefined
    ? OPENCODE_STREAM_TRACKING_LIMIT_MESSAGE
    : `${OPENCODE_STREAM_TRACKING_LIMIT_MESSAGE}: ${reason}`;
}

export function trackOpenCodeStreamEvent(
  state: StreamTrackingState,
  event: OpenCodeStreamEvent,
): boolean {
  if (state.exhausted) {
    return false;
  }
  if (event.type !== 'message.part.delta' && event.type !== 'message.part.updated') {
    state.eventCount += 1;
    if (state.eventCount > OPENCODE_STREAM_EVENT_LIMIT) {
      exhaustStreamTrackingState(state, 'event_count');
      return false;
    }
  }
  if (event.type === 'message.part.updated') {
    const part = event.properties['part'] as OpenCodePart;
    const partId = part.type === 'tool'
      ? ((part as OpenCodeToolPart).callID || part.id)
      : part.id;
    if (!trackStreamId(state, partId)) {
      return false;
    }
    rememberPartType(state, part);
    return true;
  }
  if (event.type === 'message.part.delta') {
    const partId = event.properties['partID'];
    return typeof partId !== 'string' || trackStreamId(state, partId);
  }
  return true;
}

// ---- Stream emission helpers ----

export function emitInit(
  onStream: StreamCallback | undefined,
  model: string,
  sessionId: string,
): void {
  if (!onStream) return;
  onStream({
    type: 'init',
    data: {
      model,
      sessionId,
    },
  });
}

export function emitText(onStream: StreamCallback | undefined, text: string): void {
  if (!onStream || !text) return;
  onStream({ type: 'text', data: { text } });
}

export function emitThinking(onStream: StreamCallback | undefined, thinking: string): void {
  if (!onStream || !thinking) return;
  onStream({ type: 'thinking', data: { thinking } });
}

function redactStreamChunk(
  redactors: Map<string, SensitiveTextStreamRedactor>,
  partId: string,
  text: string,
  sensitiveSources: unknown,
): string {
  const redactor = redactors.get(partId) ?? createSensitiveTextStreamRedactor();
  redactors.set(partId, redactor);
  return redactor.write(text, sensitiveSources);
}

export function flushSensitiveTextStreams(
  onStream: StreamCallback | undefined,
  state: StreamTrackingState,
): void {
  for (const redactor of state.textRedactors.values()) {
    emitText(onStream, redactor.flush(state.sensitiveSources));
  }
  for (const redactor of state.thinkingRedactors.values()) {
    emitThinking(onStream, redactor.flush(state.sensitiveSources));
  }
  state.textRedactors.clear();
  state.thinkingRedactors.clear();
}

export function emitToolUse(
  onStream: StreamCallback | undefined,
  tool: string,
  input: Record<string, unknown>,
  id: string,
): void {
  if (!onStream) return;
  const maskedInput = sanitizeOpenCodeToolInput(input, tool);
  onStream({ type: 'tool_use', data: { tool, input: maskedInput, id } });
}

export function emitToolResult(
  onStream: StreamCallback | undefined,
  content: string,
  isError: boolean,
  sensitiveSources: unknown,
  id: string,
  tool?: string,
  input?: Record<string, unknown>,
): void {
  if (!onStream) return;
  const contentWithoutToolBody = tool === undefined
    ? content
    : maskOpenCodeToolContentInText(content, tool, input);
  onStream({
    type: 'tool_result',
    data: {
      id,
      content: sanitizeSensitiveTextWithKnownValues(contentWithoutToolBody, sensitiveSources),
      isError,
    },
  });
}

export function emitPermissionAsked(
  onStream: StreamCallback | undefined,
  data: {
    requestId: string;
    sessionId: string;
    permission: string;
    patterns: string[];
    always: string[];
    reply: string;
  },
): void {
  if (!onStream) return;
  onStream({
    type: 'permission_asked',
    data: {
      ...data,
      permission: sanitizeSensitiveValue(data.permission) as string,
      patterns: sanitizeSensitiveValue(data.patterns) as string[],
      always: sanitizeSensitiveValue(data.always) as string[],
    },
  });
}

export function emitPermissionSummary(
  onStream: StreamCallback | undefined,
  data: {
    sessionId: string;
    permissionMode?: string;
    allowedTools?: readonly string[];
    networkAccess?: boolean;
    resolvedPermissions: Array<{ permission: string; pattern: string; action: string }>;
  },
): void {
  if (!onStream) return;
  onStream({ type: 'permission_summary', data });
}

export function emitResult(
  onStream: StreamCallback | undefined,
  success: boolean,
  result: string,
  sessionId: string,
  sensitiveSources: unknown,
): void {
  if (!onStream) return;
  const sanitizedResult = sanitizeSensitiveTextWithKnownValues(result, sensitiveSources);
  onStream({
    type: 'result',
    data: {
      result: sanitizedResult,
      sessionId,
      success,
      error: success ? undefined : sanitizedResult || undefined,
    },
  });
}

/** Process a message.part.updated event and emit appropriate stream events */
export function handlePartUpdated(
  part: OpenCodePart,
  delta: string | undefined,
  onStream: StreamCallback | undefined,
  state: StreamTrackingState,
): boolean {
  const partId = part.type === 'tool'
    ? (((part as OpenCodeToolPart).callID) || part.id)
    : part.id;
  if (!trackStreamId(state, partId)) {
    return false;
  }
  rememberPartType(state, part);
  switch (part.type) {
    case 'text': {
      if (!onStream) return true;
      const textPart = part as OpenCodeTextPart;
      if (delta) {
        emitText(onStream, redactStreamChunk(
          state.textRedactors,
          textPart.id,
          delta,
          state.sensitiveSources,
        ));
        const previous = state.textOffsets.get(textPart.id) ?? 0;
        state.textOffsets.set(textPart.id, previous + delta.length);
      } else {
        const prev = state.textOffsets.get(textPart.id) ?? 0;
        if (textPart.text.length > prev) {
          emitText(
            onStream,
            redactStreamChunk(
              state.textRedactors,
              textPart.id,
              textPart.text.slice(prev),
              state.sensitiveSources,
            ),
          );
          state.textOffsets.set(textPart.id, textPart.text.length);
        }
      }
      break;
    }
    case 'reasoning': {
      if (!onStream) return true;
      const reasoningPart = part as OpenCodeReasoningPart;
      if (delta) {
        if (!trackOpenCodeReasoningBytes(state, delta)) return false;
        emitThinking(onStream, redactStreamChunk(
          state.thinkingRedactors,
          reasoningPart.id,
          delta,
          state.sensitiveSources,
        ));
        const previous = state.thinkingOffsets.get(reasoningPart.id) ?? 0;
        state.thinkingOffsets.set(reasoningPart.id, previous + delta.length);
      } else {
        const prev = state.thinkingOffsets.get(reasoningPart.id) ?? 0;
        if (reasoningPart.text.length > prev) {
          const nextText = reasoningPart.text.slice(prev);
          if (!trackOpenCodeReasoningBytes(state, nextText)) return false;
          emitThinking(
            onStream,
            redactStreamChunk(
              state.thinkingRedactors,
              reasoningPart.id,
              nextText,
              state.sensitiveSources,
            ),
          );
          state.thinkingOffsets.set(reasoningPart.id, reasoningPart.text.length);
        }
      }
      break;
    }
    case 'tool': {
      const toolPart = part as OpenCodeToolPart;
      return handleToolPartUpdated(toolPart, onStream, state);
    }
    default:
      break;
  }
  return true;
}

function handleToolPartUpdated(
  toolPart: OpenCodeToolPart,
  onStream: StreamCallback | undefined,
  state: StreamTrackingState,
): boolean {
  const toolId = toolPart.callID || toolPart.id;
  const isNewTool = !state.startedTools.has(toolId);
  const inputHash = computeToolInputHash(toolPart.state.input);
  const inputChanged = inputHash === undefined
    || state.latestToolInputHashes.get(toolId) !== inputHash;
  if (inputHash !== undefined) state.latestToolInputHashes.set(toolId, inputHash);
  if (isNewTool) {
    state.startedTools.add(toolId);
  }
  // 予算は保持候補ベース（BoundedSensitiveValues 参照）なので、同一入力の
  // 再収集は候補 Set の重複排除で無害。未変更入力はスキャンコストだけ省く。
  if (isNewTool || inputChanged) {
    state.sensitiveSources.collect(toolPart.state.input);
  }
  if (state.sensitiveSources.exhausted) {
    exhaustStreamTrackingState(state, 'sensitive_sources');
    return false;
  }

  if (!onStream) return true;

  if (isNewTool) {
    emitToolUse(onStream, toolPart.tool, toolPart.state.input, toolId);
  }

  switch (toolPart.state.status) {
    case 'completed':
      emitToolResult(
        onStream,
        toolPart.state.output,
        false,
        state.sensitiveSources,
        toolId,
        toolPart.tool,
        toolPart.state.input,
      );
      break;
    case 'error':
      emitToolResult(
        onStream,
        toolPart.state.error,
        true,
        state.sensitiveSources,
        toolId,
        toolPart.tool,
        toolPart.state.input,
      );
      break;
  }
  return true;
}
