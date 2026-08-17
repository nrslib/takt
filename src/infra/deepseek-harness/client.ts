import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createInterface, type Interface } from 'node:readline';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import type { AgentResponse } from '../../core/models/index.js';
import {
  getNestedObservabilityEnvFingerprint,
  pickNestedObservabilityEnv,
} from '../../shared/telemetry/index.js';
import {
  classifyAbortSignalReason,
  createPartTimeoutFailure,
  createProviderErrorFailure,
  createProviderStreamParseFailure,
  formatAgentFailure,
  type AgentFailureDetail,
} from '../../shared/types/agent-failure.js';
import type { StreamCallback, StreamEvent } from '../../shared/types/provider.js';
import {
  assertPathSegmentsAreSafe,
  getErrorMessage,
  isAbsolutePathLike,
  spawnManagedProcess,
  type ManagedProcess,
} from '../../shared/utils/index.js';
import {
  sanitizeSensitiveTextWithKnownValues,
  sanitizeSensitiveValueWithKnownValues,
  createSensitiveTextStreamRedactor,
} from '../../shared/utils/sensitiveText.js';
import type { DeepSeekHarnessProviderOptions } from '../../core/models/workflow-types.js';
import { DEEPSEEK_HARNESS_DEFAULT_MODEL } from './constants.js';
import type { DeepSeekHarnessCallOptions } from './types.js';
const DEEPSEEK_HARNESS_STARTUP_TIMEOUT_MS = 30_000;
const DEEPSEEK_HARNESS_CALL_TIMEOUT_MS = 3_600_000;
const DEEPSEEK_HARNESS_SHUTDOWN_TIMEOUT_MS = 1_000;
const DEEPSEEK_HARNESS_MAX_STDERR_BYTES = 32 * 1024;
const DEEPSEEK_HARNESS_MAX_ERROR_BYTES = 8 * 1024;
const DEEPSEEK_HARNESS_MAX_NODE_TIMER_MS = 2_147_483_647;
const DEEPSEEK_HARNESS_BRIDGE_PROTOCOL_VERSION = 1;
const DEEPSEEK_HARNESS_RUNTIME_ENV_NAMES = ['PATH'] as const;
const DEEPSEEK_HARNESS_BRIDGE_PATH = new URL('./bridge.py', import.meta.url);

interface BridgeErrorPayload {
  code?: unknown;
  message?: unknown;
}

interface BridgeResultPayload {
  sessionId?: unknown;
  finalResponse?: unknown;
  finishReason?: unknown;
}

interface BridgeNotificationPayload {
  method?: unknown;
  payload?: unknown;
}

interface BridgeMessage {
  kind?: unknown;
  requestId?: unknown;
  result?: unknown;
  error?: BridgeErrorPayload;
  notification?: BridgeNotificationPayload;
}

interface HarnessRunResult {
  sessionId: string;
  finalResponse: string;
  finishReason: string | null;
}

interface HarnessStreamState {
  initializedSessions: Set<string>;
  sawTextBySession: Set<string>;
  pendingTextDeltasBySession: Set<string>;
  pendingThinkingDeltasBySession: Set<string>;
  emittedToolUses: Set<string>;
  emittedToolResults: Set<string>;
  finishReason?: string;
  failureReason?: string;
}

class DeepSeekHarnessProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeepSeekHarnessProtocolError';
  }
}

class DeepSeekHarnessTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeepSeekHarnessTransportError';
  }
}

class DeepSeekHarnessTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeepSeekHarnessTimeoutError';
  }
}

class DeepSeekHarnessTurnEndError extends Error {
  constructor(
    readonly responseStatus: 'blocked' | 'error',
    message: string,
  ) {
    super(message);
    this.name = 'DeepSeekHarnessTurnEndError';
  }
}

interface BridgePendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
  onNotification?: (notification: BridgeNotificationPayload) => void;
}

interface ResolvedBridgeConfiguration {
  provider: string;
  model: string;
  cwd: string;
  sessionRoot?: string;
  cordis?: string;
  maxTokens?: number;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
}

interface ProcessEnvironmentResolution {
  env: NodeJS.ProcessEnv;
  knownSecrets: Record<string, string>;
  nestedObservabilityFingerprint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, description: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new DeepSeekHarnessProtocolError(`DeepSeek Harness returned a malformed ${description}`);
  }
  return value;
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== 'string') {
    throw new DeepSeekHarnessProtocolError(`DeepSeek Harness returned a malformed ${description}`);
  }
  return value;
}

function requirePositiveSafeInteger(
  value: number | undefined,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(
      `DeepSeek Harness ${name} must be a positive safe integer no greater than ${maximum}`,
    );
  }
  return value;
}

function resolveOptionalPath(value: string | undefined, cwd: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('DeepSeek Harness path options must not be empty');
  }
  return path.resolve(cwd, trimmed);
}

function canonicalizePathWithMissingTail(pathValue: string): string {
  const missingSegments: string[] = [];
  let current = pathValue;
  while (true) {
    try {
      const canonicalPath = realpathSync(current);
      return missingSegments.reduceRight(
        (parent, segment) => path.join(parent, segment),
        canonicalPath,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new Error(`DeepSeek Harness path cannot be resolved: ${pathValue}`, { cause: error });
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`DeepSeek Harness path cannot be resolved: ${pathValue}`, { cause: error });
      }
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

function assertProjectPathBoundary(cwd: string, targetPath: string, optionName: 'session_root' | 'cordis'): void {
  assertPathSegmentsAreSafe(
    cwd,
    targetPath,
    (violation) => new Error(
      `DeepSeek Harness ${optionName} must remain inside the project/session boundary `
      + `and must not traverse symlinks (${violation})`,
    ),
  );
}

function assertSafeSessionId(sessionId: string | undefined): void {
  if (sessionId === undefined) {
    return;
  }
  if (
    sessionId.length === 0
    || sessionId === '.'
    || sessionId === '..'
    || [0, 10, 13].some((code) => sessionId.includes(String.fromCharCode(code)))
    || path.isAbsolute(sessionId)
    || path.win32.isAbsolute(sessionId)
    || /^[A-Za-z]:/u.test(sessionId)
    || sessionId.includes('/')
    || sessionId.includes('\\')
  ) {
    throw new Error(
      'DeepSeek Harness sessionId must be a non-empty path-safe identifier without NUL, '
      + 'carriage-return, line-feed, or path separators',
    );
  }
}

function assertOpaqueProtocolIdentifier(
  identifier: string,
  knownSecrets: Record<string, string>,
  description: string,
): void {
  if (sanitizeKnownSecrets(identifier, knownSecrets) !== identifier) {
    throw new Error(`DeepSeek Harness ${description} must not contain configured secret values`);
  }
}

function assertOpaqueSessionId(
  sessionId: string | undefined,
  knownSecrets: Record<string, string>,
): void {
  if (sessionId !== undefined) {
    assertOpaqueProtocolIdentifier(sessionId, knownSecrets, 'sessionId');
  }
}

function assertOpaqueToolId(id: string, knownSecrets: Record<string, string>): void {
  assertOpaqueProtocolIdentifier(id, knownSecrets, 'tool ID');
}

function assertSupportedPlatform(): void {
  const supported = (
    (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64'))
    || (process.platform === 'darwin' && process.arch === 'arm64')
  );
  if (supported) {
    return;
  }
  throw new Error(
    'Provider "deepseek-harness" requires the official DeepSeek Harness runtime on '
    + 'Linux x64/arm64 or macOS arm64. Windows, macOS x64, and other platforms are not supported; '
    + 'no provider fallback is available.',
  );
}

function resolveBridgeConfiguration(
  options: DeepSeekHarnessCallOptions,
  providerOptions: DeepSeekHarnessProviderOptions | undefined,
): ResolvedBridgeConfiguration {
  const model = options.model === undefined
    ? DEEPSEEK_HARNESS_DEFAULT_MODEL
    : options.model.trim();
  if (model.length === 0) {
    throw new Error('DeepSeek Harness model must not be empty');
  }
  assertSafeSessionId(options.sessionId);
  const cwd = canonicalizePathWithMissingTail(path.resolve(options.cwd));
  const maxTokens = requirePositiveSafeInteger(providerOptions?.maxTokens, 'maxTokens');
  const requestTimeoutMs = requirePositiveSafeInteger(
    providerOptions?.requestTimeoutMs,
    'requestTimeoutMs',
    DEEPSEEK_HARNESS_MAX_NODE_TIMER_MS,
  ) ?? DEEPSEEK_HARNESS_CALL_TIMEOUT_MS;
  const shutdownTimeoutMs = requirePositiveSafeInteger(
    providerOptions?.shutdownTimeoutMs,
    'shutdownTimeoutMs',
    DEEPSEEK_HARNESS_MAX_NODE_TIMER_MS,
  ) ?? DEEPSEEK_HARNESS_SHUTDOWN_TIMEOUT_MS;
  const sessionRootValue = providerOptions?.sessionRoot;
  const resolvedSessionRoot = resolveOptionalPath(sessionRootValue, cwd);
  if (
    resolvedSessionRoot !== undefined
    && sessionRootValue !== undefined
    && !isAbsolutePathLike(sessionRootValue.trim())
  ) {
    assertProjectPathBoundary(cwd, resolvedSessionRoot, 'session_root');
  }
  const sessionRoot = resolvedSessionRoot === undefined
    ? undefined
    : canonicalizePathWithMissingTail(resolvedSessionRoot);
  const cordisValue = providerOptions?.cordis;
  const resolvedCordis = resolveOptionalPath(cordisValue, cwd);
  if (
    resolvedCordis !== undefined
    && cordisValue !== undefined
    && !isAbsolutePathLike(cordisValue.trim())
  ) {
    assertProjectPathBoundary(cwd, resolvedCordis, 'cordis');
  }
  const cordis = resolvedCordis === undefined
    ? undefined
    : canonicalizePathWithMissingTail(resolvedCordis);
  return {
    provider: 'deepseek-official',
    model,
    cwd,
    ...(sessionRoot === undefined ? {} : { sessionRoot }),
    ...(cordis === undefined ? {} : { cordis }),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    requestTimeoutMs,
    shutdownTimeoutMs,
  };
}

function resolveUrlUserinfoSecrets(baseUrl: string | undefined): readonly string[] {
  if (baseUrl === undefined) {
    return [];
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (error) {
    throw new Error('DeepSeek Harness baseUrl must be a valid URL', { cause: error });
  }
  const encodedValues = [parsed.username, parsed.password].filter((value) => value.length > 0);
  return [...new Set(encodedValues.flatMap((value) => {
    const decoded = decodeURIComponent(value);
    return decoded === value ? [value] : [value, decoded];
  }))];
}

interface ConfiguredDeepSeekSecrets {
  apiKey: string | undefined;
  baseUrl: string | undefined;
}

function resolveConfiguredDeepSeekSecrets(
  providerOptions: DeepSeekHarnessProviderOptions | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): ConfiguredDeepSeekSecrets {
  return {
    apiKey: childProcessEnv?.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY,
    baseUrl: providerOptions?.baseUrl
      ?? childProcessEnv?.DEEPSEEK_BASE_URL
      ?? process.env.DEEPSEEK_BASE_URL,
  };
}

function resolveKnownSecrets(
  providerOptions: DeepSeekHarnessProviderOptions | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const configured = resolveConfiguredDeepSeekSecrets(providerOptions, childProcessEnv);
  const urlUserinfoSecrets = resolveUrlUserinfoSecrets(configured.baseUrl);
  return {
    ...(configured.apiKey === undefined ? {} : { DEEPSEEK_API_KEY: configured.apiKey }),
    ...(configured.baseUrl === undefined ? {} : { DEEPSEEK_BASE_URL: configured.baseUrl }),
    ...Object.fromEntries(
      urlUserinfoSecrets.map((value, index) => [`DEEPSEEK_URL_CREDENTIAL_${index}`, value]),
    ),
  };
}

// URL validation can fail before the process record exists; retain raw configured values so
// reporting that failure does not throw again before the redactor can sanitize it.
function resolveKnownSecretsForFailure(
  providerOptions: DeepSeekHarnessProviderOptions | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const configured = resolveConfiguredDeepSeekSecrets(providerOptions, childProcessEnv);
  return {
    ...(configured.apiKey === undefined ? {} : { DEEPSEEK_API_KEY: configured.apiKey }),
    ...(configured.baseUrl === undefined ? {} : { DEEPSEEK_BASE_URL: configured.baseUrl }),
  };
}

function getAmbientEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

function getProcessNestedObservabilityFingerprint(
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): string {
  return getNestedObservabilityEnvFingerprint(childProcessEnv ?? getAmbientEnvironment());
}

function resolveProcessEnvironment(
  providerOptions: DeepSeekHarnessProviderOptions | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): ProcessEnvironmentResolution {
  const env: NodeJS.ProcessEnv = {};
  for (const name of DEEPSEEK_HARNESS_RUNTIME_ENV_NAMES) {
    const value = childProcessEnv?.[name] ?? process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  Object.assign(env, pickNestedObservabilityEnv(childProcessEnv ?? getAmbientEnvironment()));

  const apiKey = childProcessEnv?.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY;
  const configuredBaseUrl = providerOptions?.baseUrl
    ?? childProcessEnv?.DEEPSEEK_BASE_URL
    ?? process.env.DEEPSEEK_BASE_URL;
  if (apiKey !== undefined) {
    env.DEEPSEEK_API_KEY = apiKey;
  }
  if (configuredBaseUrl !== undefined) {
    env.DEEPSEEK_BASE_URL = configuredBaseUrl;
  }
  if (providerOptions?.runtimeMode !== undefined) {
    env.DSH_RUNTIME_MODE = providerOptions.runtimeMode;
  }
  return {
    env,
    knownSecrets: resolveKnownSecrets(providerOptions, childProcessEnv),
    nestedObservabilityFingerprint: getProcessNestedObservabilityFingerprint(childProcessEnv),
  };
}

function stableValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function processKey(
  configuration: ResolvedBridgeConfiguration,
  providerOptions: DeepSeekHarnessProviderOptions | undefined,
  environment: ProcessEnvironmentResolution,
): string {
  const secretFingerprint = createHash('sha256')
    .update(JSON.stringify(environment.knownSecrets))
    .digest('hex');
  const nonSecretProviderOptions = providerOptions === undefined
    ? undefined
    : {
        ...providerOptions,
        baseUrl: undefined,
        ...(providerOptions.sessionRoot === undefined
          ? {}
          : { sessionRoot: configuration.sessionRoot }),
      };
  return JSON.stringify({
    configuration,
    providerOptions: stableValue(nonSecretProviderOptions),
    secretFingerprint,
    nestedObservabilityFingerprint: environment.nestedObservabilityFingerprint,
  });
}

function sanitizeKnownSecrets(text: string, knownSecrets: Record<string, string>): string {
  let sanitized = sanitizeSensitiveTextWithKnownValues(text, knownSecrets);
  for (const value of Object.values(knownSecrets)
    .filter((candidate) => candidate.length > 0)
    .sort((left, right) => right.length - left.length)) {
    sanitized = sanitized.split(value).join('[REDACTED]');
  }
  return sanitized;
}

function safeMessage(value: unknown, knownSecrets: Record<string, string>): string {
  const sanitized = sanitizeKnownSecrets(getErrorMessage(value), knownSecrets);
  if (Buffer.byteLength(sanitized, 'utf8') <= DEEPSEEK_HARNESS_MAX_ERROR_BYTES) {
    return sanitized;
  }
  return `${Buffer.from(sanitized).subarray(0, DEEPSEEK_HARNESS_MAX_ERROR_BYTES).toString('utf8')}...`;
}

function bridgeError(error: BridgeErrorPayload | undefined, knownSecrets: Record<string, string>): Error {
  const code = typeof error?.code === 'string'
    ? safeMessage(new Error(error.code), knownSecrets)
    : 'runtime-error';
  const message = typeof error?.message === 'string'
    ? safeMessage(new Error(error.message), knownSecrets)
    : 'DeepSeek Harness bridge failed without a diagnostic';
  const formatted = `DeepSeek Harness ${code}: ${message}`;
  if (code === 'timeout') {
    return new DeepSeekHarnessTimeoutError(formatted);
  }
  if (code === 'malformed-response' || code === 'protocol-error') {
    return new DeepSeekHarnessProtocolError(formatted);
  }
  return new DeepSeekHarnessTransportError(formatted);
}

function abortError(reason: unknown): Error {
  const message = reason instanceof Error ? reason.message : 'DeepSeek Harness execution aborted';
  const error = new Error(message || 'DeepSeek Harness execution aborted');
  error.name = 'AbortError';
  return error;
}

function getBridgePath(): string {
  return fileURLToPath(DEEPSEEK_HARNESS_BRIDGE_PATH);
}

function refChildStream(stream: NodeJS.ReadableStream | NodeJS.WritableStream | null): void {
  if (stream === null) {
    return;
  }
  const candidate = stream as unknown as { ref?: () => void };
  candidate.ref?.();
}

function unrefChildStream(stream: NodeJS.ReadableStream | NodeJS.WritableStream | null): void {
  if (stream === null) {
    return;
  }
  const candidate = stream as unknown as { unref?: () => void };
  candidate.unref?.();
}

function invokeStream(
  onStream: StreamCallback | undefined,
  event: StreamEvent,
  knownSecrets: Record<string, string>,
  preserveValidatedField?: 'sessionId' | 'id',
): void {
  const sanitized = sanitizeSensitiveValueWithKnownValues(event, knownSecrets) as StreamEvent;
  if (preserveValidatedField === undefined) {
    onStream?.(sanitized);
    return;
  }
  const value = (event.data as unknown as Record<string, unknown>)[preserveValidatedField];
  if (typeof value !== 'string') {
    onStream?.(sanitized);
    return;
  }
  onStream?.({
    ...sanitized,
    data: {
      ...(sanitized.data as unknown as Record<string, unknown>),
      [preserveValidatedField]: value,
    },
  } as unknown as StreamEvent);
}

function eventData(event: Record<string, unknown>): Record<string, unknown> {
  return requireRecord(event.data, 'session event data');
}

function contentBlocks(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new DeepSeekHarnessProtocolError('DeepSeek Harness returned malformed content blocks');
  }
  return value;
}

function textFromContentBlocks(value: unknown): string {
  return contentBlocks(value)
    .filter((block) => block.type === 'text')
    .map((block) => requireString(block.text, 'text content block'))
    .join('');
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  const text = requireString(raw, 'tool-call arguments');
  if (text.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new DeepSeekHarnessProtocolError('DeepSeek Harness returned invalid JSON tool-call arguments');
  }
  if (!isRecord(parsed)) {
    throw new DeepSeekHarnessProtocolError('DeepSeek Harness tool-call arguments must be a JSON object');
  }
  return parsed;
}

function toolUseEvent(
  id: string,
  name: string,
  input: Record<string, unknown>,
): StreamEvent {
  return { type: 'tool_use', data: { id, tool: name, input } };
}

function toolResultEvent(id: string, content: string, isError: boolean): StreamEvent {
  return { type: 'tool_result', data: { id, content, isError } };
}

function recordFailureReason(state: HarnessStreamState, reason: Record<string, unknown>): void {
  const reasonError = reason.error;
  if (isRecord(reasonError)) {
    const message = typeof reasonError.message === 'string' ? reasonError.message : undefined;
    const code = typeof reasonError.code === 'string' ? reasonError.code : undefined;
    if (message !== undefined && code !== undefined) {
      state.failureReason = `${code}: ${message}`;
      return;
    }
    if (message !== undefined) {
      state.failureReason = message;
      return;
    }
  }
  if (typeof reason.message === 'string') {
    state.failureReason = reason.message;
  }
}

function normalizeHarnessEvent(
  sessionId: string,
  event: Record<string, unknown>,
  state: HarnessStreamState,
  onStream: StreamCallback | undefined,
  knownSecrets: Record<string, string>,
): void {
  const type = requireString(event.type, 'session event type');
  if (type === 'assistant/chunk') {
    const data = eventData(event);
    const chunk = requireRecord(data.chunk, 'assistant chunk');
    const chunkType = requireString(chunk.type, 'assistant chunk type');
    if (chunkType === 'text-delta') {
      const text = requireString(chunk.text, 'assistant text delta');
      if (text.length > 0) {
        state.sawTextBySession.add(sessionId);
        state.pendingTextDeltasBySession.add(sessionId);
        invokeStream(onStream, { type: 'text', data: { text } }, knownSecrets);
      }
    } else if (chunkType === 'reasoning-delta') {
      const thinking = requireString(chunk.text, 'assistant reasoning delta');
      if (thinking.length > 0) {
        state.pendingThinkingDeltasBySession.add(sessionId);
        invokeStream(onStream, { type: 'thinking', data: { thinking } }, knownSecrets);
      }
    }
    return;
  }

  if (type === 'assistant/message') {
    const data = eventData(event);
    const message = requireRecord(data.message, 'assistant message');
    const blocks = contentBlocks(message.content);
    const hasTextDelta = state.pendingTextDeltasBySession.delete(sessionId);
    const text = textFromContentBlocks(blocks);
    if (!hasTextDelta && text.length > 0) {
      state.sawTextBySession.add(sessionId);
      invokeStream(onStream, { type: 'text', data: { text } }, knownSecrets);
    }
    const hasThinkingDelta = state.pendingThinkingDeltasBySession.delete(sessionId);
    const thinking = blocks
      .filter((block) => block.type === 'reasoning')
      .map((block) => requireString(block.text, 'reasoning content block'))
      .join('');
    if (!hasThinkingDelta && thinking.length > 0) {
      invokeStream(onStream, { type: 'thinking', data: { thinking } }, knownSecrets);
    }
    for (const block of blocks) {
      if (block.type === 'tool-call') {
        const id = requireString(block.id, 'tool-call id');
        assertOpaqueToolId(id, knownSecrets);
        const name = requireString(block.name, 'tool-call name');
        if (!state.emittedToolUses.has(id)) {
          state.emittedToolUses.add(id);
          invokeStream(onStream, toolUseEvent(id, name, parseToolArguments(block.arguments)), knownSecrets, 'id');
        }
      }
      if (block.type === 'tool-result') {
        const id = requireString(block.toolCallId, 'tool-result id');
        assertOpaqueToolId(id, knownSecrets);
        if (!state.emittedToolResults.has(id)) {
          state.emittedToolResults.add(id);
          invokeStream(onStream, toolResultEvent(
            id,
            textFromContentBlocks(block.content),
            block.isError === true,
          ), knownSecrets, 'id');
        }
      }
    }
    return;
  }

  if (type === 'tool/call') {
    const data = eventData(event);
    const id = requireString(data.callId, 'tool-call id');
    assertOpaqueToolId(id, knownSecrets);
    const name = requireString(data.name, 'tool-call name');
    if (!state.emittedToolUses.has(id)) {
      state.emittedToolUses.add(id);
      invokeStream(onStream, toolUseEvent(id, name, parseToolArguments(data.arguments)), knownSecrets, 'id');
    }
    return;
  }

  if (type === 'tool/result') {
    const data = eventData(event);
    const message = requireRecord(data.message, 'tool-result message');
    const source = requireRecord(message.source, 'tool-result source');
    const id = requireString(source.callId, 'tool-result id');
    assertOpaqueToolId(id, knownSecrets);
    if (!state.emittedToolResults.has(id)) {
      state.emittedToolResults.add(id);
      const messageBlocks = contentBlocks(message.content);
      const toolResultBlock = messageBlocks.find((block) => block.type === 'tool-result');
      const resultContent = toolResultBlock === undefined
        ? textFromContentBlocks(messageBlocks)
        : textFromContentBlocks(toolResultBlock.content);
      invokeStream(onStream, toolResultEvent(
        id,
        resultContent,
        toolResultBlock?.isError === true || (data.error !== undefined && data.error !== null),
      ), knownSecrets, 'id');
    }
    return;
  }

  if (type === 'turn/end') {
    const data = eventData(event);
    const reason = requireRecord(data.reason, 'turn end reason');
    if (state.initializedSessions.has(sessionId)) {
      state.finishReason = requireString(reason.kind, 'turn end reason kind');
      if (state.finishReason === 'error') {
        recordFailureReason(state, reason);
      }
    }
  }
}

function normalizeHarnessNotification(
  notification: BridgeNotificationPayload,
  state: HarnessStreamState,
  onStream: StreamCallback | undefined,
  model: string,
  knownSecrets: Record<string, string>,
): void {
  const method = requireString(notification.method, 'notification method');
  if (method !== 'session.started' && method !== 'session.event' && method !== 'session.status') {
    return;
  }
  const payload = requireRecord(notification.payload, 'session notification payload');
  const sessionId = requireString(payload.sessionId, 'session notification sessionId');
  assertSafeSessionId(sessionId);
  assertOpaqueSessionId(sessionId, knownSecrets);
  if (method === 'session.started') {
    if (!state.initializedSessions.has(sessionId)) {
      state.initializedSessions.add(sessionId);
      invokeStream(onStream, { type: 'init', data: { model, sessionId } }, knownSecrets, 'sessionId');
    }
    return;
  }
  if (method !== 'session.event') {
    return;
  }
  const event = requireRecord(payload.event, 'session event');
  normalizeHarnessEvent(sessionId, event, state, onStream, knownSecrets);
}

class DeepSeekHarnessProcess {
  private child: ChildProcess | undefined;
  private managed: ManagedProcess | undefined;
  private reader: Interface | undefined;
  private startPromise: Promise<void> | undefined;
  private ready = false;
  private closed = false;
  private closing = false;
  private readonly pending = new Map<string, BridgePendingRequest>();
  private requestSequence = 0;
  private terminationPromise: Promise<void> | undefined;
  private readonly stderrRedactor = createSensitiveTextStreamRedactor();
  private stderr = '';
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly configuration: ResolvedBridgeConfiguration,
    private readonly pythonPath: string,
    private readonly environment: ProcessEnvironmentResolution,
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  get pythonEnvironment(): NodeJS.ProcessEnv {
    return this.environment.env;
  }

  get knownSecrets(): Record<string, string> {
    return this.environment.knownSecrets;
  }

  async start(abortSignal?: AbortSignal): Promise<void> {
    if (this.ready) {
      return;
    }
    if (this.startPromise === undefined) {
      this.startPromise = this.startInternal();
    }
    try {
      await waitForAbortable(this.startPromise, abortSignal);
    } catch (error) {
      await this.terminate().catch(() => undefined);
      if (abortSignal?.aborted === true) {
        throw abortError(abortSignal.reason);
      }
      throw error;
    }
  }

  private async startInternal(): Promise<void> {
    assertSupportedPlatform();
    if (this.closed) {
      throw new DeepSeekHarnessTransportError('DeepSeek Harness bridge is closed');
    }
    let managed: ManagedProcess;
    try {
      managed = spawnManagedProcess(
        this.pythonPath,
        ['-u', getBridgePath()],
        {
          cwd: this.configuration.cwd,
          env: this.pythonEnvironment,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
        undefined,
        { terminationMode: 'process-tree' },
      );
    } catch (error) {
      throw new Error(
        `Unable to start DeepSeek Harness Python bridge with "${this.pythonPath}". `
        + 'Install Python 3.10+ and deepseek-harness-sdk with its matching runtime wheel, '
        + 'or set provider_options.deepseek_harness.python_path.',
        { cause: error },
      );
    }
    this.managed = managed;
    this.child = managed.child;
    this.attachChild(managed.child);

    try {
      await this.request(
        {
          type: 'start',
          protocolVersion: DEEPSEEK_HARNESS_BRIDGE_PROTOCOL_VERSION,
          id: this.nextRequestId(),
          config: this.configuration,
        },
        undefined,
        this.configuration.requestTimeoutMs < DEEPSEEK_HARNESS_STARTUP_TIMEOUT_MS
          ? this.configuration.requestTimeoutMs
          : DEEPSEEK_HARNESS_STARTUP_TIMEOUT_MS,
      );
      this.ready = true;
    } catch (error) {
      await this.terminate();
      const diagnostic = safeMessage(error, this.knownSecrets);
      if (diagnostic.includes('ENOENT') || diagnostic.toLowerCase().includes('not found')) {
        throw new Error(
          `Unable to start DeepSeek Harness Python bridge with "${this.pythonPath}". `
          + 'Install Python 3.10+ and deepseek-harness-sdk with its matching runtime wheel, '
          + 'or set provider_options.deepseek_harness.python_path.',
          { cause: error },
        );
      }
      throw error;
    }
  }

  private attachChild(child: ChildProcess): void {
    this.reader = child.stdout === null
      ? undefined
      : createInterface({ input: child.stdout });
    this.reader?.on('line', (line: string) => this.handleLine(line));
    this.reader?.on('close', () => {
      if (!this.closed && !this.closing) {
        this.markClosed(new DeepSeekHarnessTransportError(
          this.diagnostics(this.processExitReason('stdout closed')),
        ));
        void this.terminate();
      }
    });
    const onStreamError = (error: unknown): void => {
      if (this.closed || this.closing) {
        return;
      }
      this.markClosed(new DeepSeekHarnessTransportError(
        this.diagnostics(`bridge stream failed: ${safeMessage(error, this.knownSecrets)}`),
      ));
      void this.terminate();
    };
    child.stdin?.on('error', onStreamError);
    child.stdout?.on('error', onStreamError);
    child.stderr?.on('error', onStreamError);
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.appendStderr(this.stderrRedactor.write(text, this.knownSecrets));
    });
    void this.managed?.wait().then(
      ({ code, signal }) => {
        if (!this.closed && !this.closing) {
          this.markClosed(new DeepSeekHarnessTransportError(
            this.diagnostics(`process exited with ${code === null ? String(signal) : String(code)}`),
          ));
          void this.terminate();
        }
      },
      (error: unknown) => {
        if (!this.closed && !this.closing) {
          this.markClosed(new DeepSeekHarnessTransportError(this.diagnostics(safeMessage(error, this.knownSecrets))));
          void this.terminate();
        }
      },
    );
  }

  private refForActivity(): void {
    this.child?.ref();
    refChildStream(this.child?.stdin ?? null);
    refChildStream(this.child?.stdout ?? null);
    refChildStream(this.child?.stderr ?? null);
  }

  private unrefForIdle(): void {
    unrefChildStream(this.child?.stdin ?? null);
    unrefChildStream(this.child?.stdout ?? null);
    unrefChildStream(this.child?.stderr ?? null);
    this.child?.unref();
  }

  private nextRequestId(): string {
    this.requestSequence += 1;
    return `${this.requestSequence}`;
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0 || this.closed) {
      return;
    }
    let message: BridgeMessage;
    try {
      const parsed: unknown = JSON.parse(line) as unknown;
      message = requireRecord(parsed, 'bridge response') as BridgeMessage;
    } catch (error) {
      this.markClosed(new DeepSeekHarnessProtocolError(
        error instanceof DeepSeekHarnessProtocolError
          ? error.message
          : 'DeepSeek Harness bridge returned malformed JSON',
      ));
      void this.terminate();
      return;
    }

    try {
      const kind = message.kind;
      if (kind === 'notification') {
        const requestId = requireString(message.requestId, 'notification requestId');
        const pending = this.pending.get(requestId);
        if (pending === undefined || pending.onNotification === undefined || message.notification === undefined) {
          throw new DeepSeekHarnessProtocolError('DeepSeek Harness bridge returned an invalid notification');
        }
        try {
          pending.onNotification(message.notification);
        } catch (error) {
          this.pending.delete(requestId);
          if (pending.timeout !== undefined) {
            clearTimeout(pending.timeout);
          }
          pending.reject(error instanceof Error ? error : new Error(String(error)));
          void this.terminate();
        }
        return;
      }

      if (kind === 'fatal') {
        this.markClosed(bridgeError(message.error, this.knownSecrets));
        void this.terminate();
        return;
      }

      const requestId = requireString(message.requestId, 'bridge response requestId');
      const pending = this.pending.get(requestId);
      if (pending === undefined) {
        throw new DeepSeekHarnessProtocolError('DeepSeek Harness bridge returned an unknown request id');
      }
      this.pending.delete(requestId);
      if (pending.timeout !== undefined) {
        clearTimeout(pending.timeout);
      }
      if (kind === 'error') {
        pending.reject(bridgeError(message.error, this.knownSecrets));
        return;
      }
      if (kind === 'ready' || kind === 'closed') {
        pending.resolve(undefined);
        return;
      }
      if (kind === 'result') {
        pending.resolve(message.result);
        return;
      }
      const protocolError = new DeepSeekHarnessProtocolError(
        'DeepSeek Harness bridge returned an unknown message kind',
      );
      pending.reject(protocolError);
      throw protocolError;
    } catch (error) {
      const protocolError = error instanceof Error
        ? error
        : new DeepSeekHarnessProtocolError('DeepSeek Harness bridge response was malformed');
      this.markClosed(protocolError);
      void this.terminate();
    }
  }

  private processExitReason(fallback: string): string {
    const child = this.child;
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      return `process exited with ${child.exitCode}`;
    }
    if (child?.signalCode !== null && child?.signalCode !== undefined) {
      return `process exited with ${child.signalCode}`;
    }
    return fallback;
  }

  private appendStderr(text: string): void {
    if (text.length === 0) {
      return;
    }
    const combined = Buffer.concat([
      Buffer.from(this.stderr, 'utf8'),
      Buffer.from(text, 'utf8'),
    ]);
    this.stderr = combined.subarray(Math.max(0, combined.length - DEEPSEEK_HARNESS_MAX_STDERR_BYTES)).toString('utf8');
  }

  private diagnostics(reason: string): string {
    this.appendStderr(this.stderrRedactor.flush(this.knownSecrets));
    const tail = sanitizeKnownSecrets(this.stderr.trim(), this.knownSecrets).trim();
    return tail.length === 0 ? `DeepSeek Harness ${reason}` : `DeepSeek Harness ${reason}\nstderr tail:\n${tail}`;
  }

  private markClosed(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.ready = false;
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      if (pending.timeout !== undefined) {
        clearTimeout(pending.timeout);
      }
      pending.reject(error);
    }
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed || this.child?.stdin === null || this.child?.stdin === undefined) {
      throw new DeepSeekHarnessTransportError(this.diagnostics('bridge is not running'));
    }
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      throw new DeepSeekHarnessTransportError(
        this.diagnostics(`failed to write bridge request: ${safeMessage(error, this.knownSecrets)}`),
      );
    }
  }

  private request(
    message: Record<string, unknown>,
    onNotification: ((notification: BridgeNotificationPayload) => void) | undefined,
    timeoutMs: number | undefined,
    abortSignal?: AbortSignal,
  ): Promise<unknown> {
    const requestId = requireString(message.id, 'bridge request id');
    return new Promise<unknown>((resolve, reject) => {
      if (this.closed) {
        reject(new DeepSeekHarnessTransportError(this.diagnostics('bridge is closed')));
        return;
      }
      let settled = false;
      let abortHandler: (() => void) | undefined;
      const settle = (action: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (abortSignal !== undefined && abortHandler !== undefined) {
          abortSignal.removeEventListener('abort', abortHandler);
        }
        action();
      };
      const pending: BridgePendingRequest = {
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => settle(() => reject(error)),
        timeout: undefined,
        onNotification,
      };
      this.pending.set(requestId, pending);
      const terminateAndReject = (error: Error): void => {
        this.pending.delete(requestId);
        if (pending.timeout !== undefined) {
          clearTimeout(pending.timeout);
        }
        pending.reject(error);
        void this.terminate().catch(() => undefined);
      };
      if (timeoutMs !== undefined) {
        pending.timeout = setTimeout(() => {
          terminateAndReject(new DeepSeekHarnessTimeoutError(
            `DeepSeek Harness request timed out after ${timeoutMs}ms`,
          ));
        }, timeoutMs);
        pending.timeout.unref?.();
      }
      if (abortSignal !== undefined) {
        abortHandler = (): void => {
          terminateAndReject(abortError(abortSignal.reason));
        };
        if (abortSignal.aborted) {
          abortHandler();
          return;
        }
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      }
      try {
        this.write(message);
      } catch (error) {
        this.pending.delete(requestId);
        if (pending.timeout !== undefined) {
          clearTimeout(pending.timeout);
        }
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async run(
    prompt: string,
    sessionId: string | undefined,
    state: HarnessStreamState,
    onStream: StreamCallback | undefined,
    abortSignal: AbortSignal | undefined,
  ): Promise<HarnessRunResult> {
    const previous = this.operationTail.catch(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.operationTail = previous.then(() => gate);
    let activityStarted = false;
    try {
      await waitForAbortable(previous, abortSignal);
      this.refForActivity();
      activityStarted = true;
      await this.start(abortSignal);
      const requestId = this.nextRequestId();
      const raw = await this.request(
        {
          type: 'run',
          protocolVersion: DEEPSEEK_HARNESS_BRIDGE_PROTOCOL_VERSION,
          id: requestId,
          prompt,
          ...(sessionId === undefined ? {} : { sessionId }),
        },
        (notification) => normalizeHarnessNotification(
          notification,
          state,
          onStream,
          this.configuration.model,
          this.knownSecrets,
        ),
        this.configuration.requestTimeoutMs,
        abortSignal,
      );
      const result = requireRecord(raw, 'run result') as BridgeResultPayload;
      const activeSessionId = requireString(result.sessionId, 'run result sessionId');
      assertSafeSessionId(activeSessionId);
      assertOpaqueSessionId(activeSessionId, this.knownSecrets);
      if (sessionId !== undefined && activeSessionId !== sessionId) {
        throw new DeepSeekHarnessProtocolError(
          'DeepSeek Harness returned a sessionId different from the requested session',
        );
      }
      const finalResponse = requireString(result.finalResponse, 'run result finalResponse');
      const finishReason = result.finishReason === null
        ? null
        : requireString(result.finishReason, 'run result finishReason');
      if (state.finishReason !== finishReason) {
        throw new DeepSeekHarnessProtocolError(
          'DeepSeek Harness run result finishReason did not match the root session turn/end event',
        );
      }
      return { sessionId: activeSessionId, finalResponse, finishReason };
    } finally {
      try {
        if (activityStarted) {
          if (sessionId === undefined) {
            await this.close();
          } else {
            this.unrefForIdle();
          }
        }
      } finally {
        release();
      }
    }
  }

  async close(): Promise<void> {
    this.refForActivity();
    if (this.closed) {
      await this.terminate();
      return;
    }
    this.closing = true;
    try {
      if (this.ready) {
        const requestId = this.nextRequestId();
        await this.request(
          {
            type: 'close',
            protocolVersion: DEEPSEEK_HARNESS_BRIDGE_PROTOCOL_VERSION,
            id: requestId,
          },
          undefined,
          this.configuration.shutdownTimeoutMs,
        );
      }
    } catch {
      // Termination below owns cleanup when the SDK cannot answer shutdown.
    } finally {
      await this.terminate();
    }
  }

  private terminate(): Promise<void> {
    if (this.terminationPromise !== undefined) {
      return this.terminationPromise;
    }
    if (this.closed && this.managed === undefined) {
      return Promise.resolve();
    }
    this.terminationPromise = this.terminateInternal();
    return this.terminationPromise;
  }

  private async terminateInternal(): Promise<void> {
    this.closed = true;
    this.ready = false;
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      if (pending.timeout !== undefined) {
        clearTimeout(pending.timeout);
      }
      pending.reject(new DeepSeekHarnessTransportError(this.diagnostics('bridge terminated')));
    }
    this.reader?.close();
    const managed = this.managed;
    this.managed = undefined;
    this.child = undefined;
    if (managed === undefined) {
      return;
    }
    try {
      await managed.terminate();
    } catch {
      await managed.wait().catch(() => undefined);
    }
  }

  killForExit(): void {
    const child = this.child;
    if (
      child?.pid === undefined
      || child.exitCode !== null
      || child.signalCode !== null
      || child.killed
    ) {
      return;
    }
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

async function waitForAbortable(
  operation: Promise<void>,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  if (abortSignal === undefined) {
    await operation;
    return;
  }
  if (abortSignal.aborted) {
    throw abortError(abortSignal.reason);
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      abortSignal.removeEventListener('abort', onAbort);
      reject(abortError(abortSignal.reason));
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      () => {
        abortSignal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error: unknown) => {
        abortSignal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

interface SessionBinding {
  identity: string;
}

interface SessionRootBinding {
  cwd: string;
  processes: Set<DeepSeekHarnessProcess>;
}

const processes = new Map<string, DeepSeekHarnessProcess>();
const sessionBindings = new Map<string, SessionBinding>();
const sessionRootBindings = new Map<string, SessionRootBinding>();
let oneShotProcessSequence = 0;
let exitCleanupRegistered = false;

function registerExitCleanup(): void {
  if (exitCleanupRegistered) {
    return;
  }
  process.once('exit', () => {
    for (const processRecord of processes.values()) {
      processRecord.killForExit();
    }
  });
  exitCleanupRegistered = true;
}

function removeProcess(processRecord: DeepSeekHarnessProcess): void {
  for (const [key, value] of processes) {
    if (value === processRecord) {
      processes.delete(key);
    }
  }
  for (const binding of sessionRootBindings.values()) {
    binding.processes.delete(processRecord);
  }
}

function registerProcessBindings(
  processRecord: DeepSeekHarnessProcess,
  configuration: ResolvedBridgeConfiguration,
  sessionId: string | undefined,
  identity: string,
): void {
  if (sessionId !== undefined) {
    const existingSession = sessionBindings.get(sessionId);
    if (existingSession !== undefined && existingSession.identity !== identity) {
      throw new Error(
        'DeepSeek Harness sessionId is already bound to a different project, session root, or bridge configuration',
      );
    }
  }

  if (configuration.sessionRoot !== undefined) {
    const existingRoot = sessionRootBindings.get(configuration.sessionRoot);
    if (existingRoot !== undefined) {
      for (const boundProcess of existingRoot.processes) {
        if (boundProcess.isClosed) {
          existingRoot.processes.delete(boundProcess);
        }
      }
      if (existingRoot.cwd !== configuration.cwd) {
        throw new Error(
          'DeepSeek Harness session_root is already bound to a different project in this process',
        );
      }
    }
    const rootBinding = existingRoot ?? {
      cwd: configuration.cwd,
      processes: new Set<DeepSeekHarnessProcess>(),
    };
    rootBinding.processes.add(processRecord);
    sessionRootBindings.set(configuration.sessionRoot, rootBinding);
  }
  if (sessionId !== undefined) {
    sessionBindings.set(sessionId, { identity });
  }
}

function getOrCreateProcess(options: DeepSeekHarnessCallOptions): DeepSeekHarnessProcess {
  assertSupportedPlatform();
  const providerOptions = options.providerOptions;
  const configuration = resolveBridgeConfiguration(options, providerOptions);
  const environment = resolveProcessEnvironment(providerOptions, options.childProcessEnv);
  assertOpaqueSessionId(options.sessionId, environment.knownSecrets);
  const baseKey = processKey(configuration, providerOptions, environment);
  const key = options.sessionId === undefined
    ? `${baseKey}:one-shot:${++oneShotProcessSequence}`
    : `${baseKey}:session`;
  if (options.sessionId !== undefined) {
    const existing = processes.get(key);
    if (existing !== undefined && !existing.isClosed) {
      return existing;
    }
    if (existing !== undefined) {
      removeProcess(existing);
    }
  }
  const configuredPythonPath = providerOptions?.pythonPath;
  const pythonPath = configuredPythonPath === undefined ? 'python3' : configuredPythonPath.trim();
  if (pythonPath.length === 0) {
    throw new Error('DeepSeek Harness pythonPath must not be empty');
  }
  const processRecord = new DeepSeekHarnessProcess(configuration, pythonPath, environment);
  processes.set(key, processRecord);
  try {
    registerProcessBindings(processRecord, configuration, options.sessionId, baseKey);
  } catch (error) {
    removeProcess(processRecord);
    throw error;
  }
  registerExitCleanup();
  return processRecord;
}

function failureDetail(
  error: unknown,
  options: DeepSeekHarnessCallOptions,
  knownSecrets: Record<string, string>,
): AgentFailureDetail {
  if (options.abortSignal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) {
    const detail = classifyAbortSignalReason(options.abortSignal?.reason ?? error);
    return { ...detail, reason: safeMessage(detail.reason, knownSecrets) };
  }
  if (error instanceof DeepSeekHarnessTimeoutError) {
    return createPartTimeoutFailure(error.message);
  }
  if (error instanceof DeepSeekHarnessProtocolError) {
    return createProviderStreamParseFailure(safeMessage(error, knownSecrets));
  }
  return createProviderErrorFailure(safeMessage(error, knownSecrets));
}

function emitFailure(
  onStream: StreamCallback | undefined,
  content: string,
  sessionId: string | undefined,
  detail: AgentFailureDetail,
  responseStatus: 'blocked' | 'error',
  knownSecrets: Record<string, string>,
  preserveSessionId: boolean,
): void {
  invokeStream(onStream, { type: 'error', data: { message: content, raw: content } }, knownSecrets);
  invokeStream(onStream, {
    type: 'result',
    data: {
      result: content,
      success: false,
      sessionId: sessionId ?? 'unknown',
      error: content,
      ...(responseStatus === 'error' ? { failureCategory: detail.category } : {}),
    },
  }, knownSecrets, preserveSessionId ? 'sessionId' : undefined);
}

function finishReasonFailure(state: HarnessStreamState): Error {
  const reason = state.failureReason ?? 'DeepSeek Harness turn ended with an error';
  return new Error(reason);
}

function createSuccessResponse(
  agentType: string,
  result: HarnessRunResult,
  state: HarnessStreamState,
  options: DeepSeekHarnessCallOptions,
  knownSecrets: Record<string, string>,
): AgentResponse {
  if (result.finishReason === 'error') {
    throw finishReasonFailure(state);
  }
  if (result.finishReason === 'aborted') {
    throw abortError(state.failureReason ?? 'DeepSeek Harness turn was aborted');
  }
  if (result.finishReason === 'blocked') {
    throw new DeepSeekHarnessTurnEndError(
      'blocked',
      state.failureReason ?? 'DeepSeek Harness turn was blocked',
    );
  }
  if (result.finishReason === 'max-tokens') {
    throw new DeepSeekHarnessTurnEndError(
      'error',
      state.failureReason ?? 'DeepSeek Harness turn reached the maximum token limit',
    );
  }
  if (result.finishReason === 'interrupted') {
    throw new DeepSeekHarnessTurnEndError(
      'error',
      state.failureReason ?? 'DeepSeek Harness turn was interrupted',
    );
  }
  if (result.finishReason === null) {
    throw new DeepSeekHarnessProtocolError('DeepSeek Harness returned no turn completion reason');
  }
  if (result.finishReason !== 'completed') {
    throw new DeepSeekHarnessProtocolError(
      `DeepSeek Harness returned unsupported turn completion reason "${result.finishReason}"`,
    );
  }
  const finalResponse = sanitizeKnownSecrets(result.finalResponse, knownSecrets);
  assertSafeSessionId(result.sessionId);
  assertOpaqueSessionId(result.sessionId, knownSecrets);
  if (finalResponse.length === 0) {
    throw new DeepSeekHarnessProtocolError('DeepSeek Harness returned no assistant text');
  }
  if (!state.sawTextBySession.has(result.sessionId)) {
    invokeStream(options.onStream, { type: 'text', data: { text: finalResponse } }, knownSecrets);
  }
  invokeStream(options.onStream, {
    type: 'result',
    data: {
      result: finalResponse,
      success: true,
      sessionId: result.sessionId,
    },
  }, knownSecrets, 'sessionId');
  return {
    persona: agentType,
    status: 'done',
    content: finalResponse,
    timestamp: new Date(),
    sessionId: result.sessionId,
  };
}

export async function callDeepSeekHarness(
  agentType: string,
  prompt: string,
  options: DeepSeekHarnessCallOptions,
): Promise<AgentResponse> {
  let processRecord: DeepSeekHarnessProcess | undefined;
  const requestedSessionId = options.sessionId;
  try {
    processRecord = getOrCreateProcess(options);
    const state: HarnessStreamState = {
      initializedSessions: new Set(),
      sawTextBySession: new Set(),
      pendingTextDeltasBySession: new Set(),
      pendingThinkingDeltasBySession: new Set(),
      emittedToolUses: new Set(),
      emittedToolResults: new Set(),
    };
    const result = await processRecord.run(
      prompt,
      requestedSessionId,
      state,
      options.onStream,
      options.abortSignal,
    );
    const response = createSuccessResponse(
      agentType,
      result,
      state,
      options,
      processRecord.knownSecrets,
    );
    if (requestedSessionId === undefined) {
      await processRecord.close();
      removeProcess(processRecord);
    }
    return response;
  } catch (error) {
    const knownSecrets = processRecord?.knownSecrets
      ?? resolveKnownSecretsForFailure(options.providerOptions, options.childProcessEnv);
    const detail = failureDetail(error, options, knownSecrets);
    const content = formatAgentFailure(detail);
    const responseStatus = error instanceof DeepSeekHarnessTurnEndError
      ? error.responseStatus
      : 'error';
    const preserveRequestedSessionId = processRecord !== undefined && requestedSessionId !== undefined;
    emitFailure(
      options.onStream,
      content,
      requestedSessionId,
      detail,
      responseStatus,
      knownSecrets,
      preserveRequestedSessionId,
    );
    if (requestedSessionId === undefined && processRecord !== undefined) {
      await processRecord.close();
      removeProcess(processRecord);
    } else if (
      processRecord !== undefined
      && (error instanceof DeepSeekHarnessProtocolError || error instanceof DeepSeekHarnessTimeoutError)
    ) {
      await processRecord.close();
      removeProcess(processRecord);
    } else if (processRecord?.isClosed === true) {
      removeProcess(processRecord);
    }
    return {
      persona: agentType,
      status: responseStatus,
      content,
      error: content,
      ...(responseStatus === 'error' ? { failureCategory: detail.category } : {}),
      timestamp: new Date(),
      sessionId: preserveRequestedSessionId ? requestedSessionId : undefined,
    };
  }
}

export async function closeDeepSeekHarnessProcesses(): Promise<void> {
  const active = [...processes.values()];
  processes.clear();
  sessionBindings.clear();
  sessionRootBindings.clear();
  await Promise.all(active.map((processRecord) => processRecord.close()));
}
