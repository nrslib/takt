import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeepSeekHarness, HarnessNotification } from '@deepseek-ai/dsh-sdk-client';
import type { AgentResponse } from '../../core/models/index.js';
import {
  getNestedObservabilityEnvFingerprint,
  pickNestedObservabilityEnv,
} from '../../shared/telemetry/index.js';
import {
  AGENT_FAILURE_CATEGORIES,
  classifyAbortSignalReason,
  createPartTimeoutFailure,
  createProviderErrorFailure,
  createProviderStreamParseFailure,
  createSessionContinuationUnsupportedFailure,
  formatAgentFailure,
  type AgentFailureDetail,
} from '../../shared/types/agent-failure.js';
import type { StreamCallback, StreamEvent } from '../../shared/types/provider.js';
import {
  getErrorMessage,
  sanitizeTerminalText,
} from '../../shared/utils/index.js';
import {
  sanitizeSensitiveTextWithKnownValues,
  sanitizeSensitiveValueWithKnownValues,
} from '../../shared/utils/sensitiveText.js';
import {
  collectEmbeddedSensitiveValues,
  hasPotentialSensitiveTextSuffix,
  SENSITIVE_TEXT_BOUNDARY_WINDOW,
} from '../../shared/utils/sensitive-text.js';
import { collectSensitiveStringValues } from '../../shared/utils/sensitive-value.js';
import type {
  DeepSeekHarnessProviderOptions,
  DeepSeekReasoningEffort,
} from '../../core/models/workflow-types.js';
import { DEEPSEEK_HARNESS_DEFAULT_CREDENTIAL_REFERENCE, DEEPSEEK_HARNESS_DEFAULT_MODEL } from './constants.js';
import { assertSupportedDeepSeekHarnessPlatform } from './platform.js';
import {
  DeepSeekHarnessInstallRequiredError,
  loadManagedDeepSeekHarnessModules,
  type ManagedDeepSeekHarnessModules,
} from './managed-package.js';
import { parseDeepSeekHarnessModelReference } from './model-reference.js';
import { type DeepSeekCredentialHomeOrigin } from './credential-home.js';
import { resolveConfiguredDeepSeekEndpoint } from './endpoint-consistency.js';
import {
  resolveDeepSeekCredentialBinding,
  type DeepSeekCredentialBinding,
} from './credential-binding.js';
import {
  createDeepSeekCredentialPatch,
  type DeepSeekCredentialPatch,
} from './credential-patch.js';
import {
  buildCredentialDiagnostic,
  buildDeepSeekRuntimeFailureDiagnostic,
  buildDeepSeekSdkFailureDiagnostic,
  classifyDeepSeekRuntimeCredentialFailure,
  classifyDeepSeekRuntimeFailure,
  projectDeepSeekRuntimeMessage,
  DeepSeekCredentialDiagnosticError,
  type DeepSeekRuntimeFailureEvidence,
  type DeepSeekCredentialFailureClassification,
} from './credential-diagnostics.js';
import {
  abortError,
  createSessionDispatchQueue,
  waitForAbortable,
} from './session-dispatch.js';
import {
  assertDeepSeekRuntimeCreationAllowed,
  DeepSeekRuntimeCreationBlockedError,
  DeepSeekRuntimeBusyError,
  deepSeekCleanupBlockedMessage,
  deepSeekContinuationMessage,
  getDeepSeekRuntimePaths,
  markDeepSeekSessionUsed,
  markDeepSeekCleanupFailure,
  withDeepSeekRuntimeCreation,
} from './runtime-state.js';
import type { DeepSeekHarnessCallOptions } from './types.js';
const DEEPSEEK_HARNESS_STARTUP_TIMEOUT_MS = 30_000;
const DEEPSEEK_HARNESS_CALL_TIMEOUT_MS = 3_600_000;
const DEEPSEEK_HARNESS_SHUTDOWN_TIMEOUT_MS = 1_000;
const DEEPSEEK_HARNESS_MAX_ERROR_BYTES = 8 * 1024;
const DEEPSEEK_HARNESS_MAX_PENDING_RESPONSE_LENGTH = 10_000;
const DEEPSEEK_HARNESS_MAX_NODE_TIMER_MS = 2_147_483_647;
const DEEPSEEK_HARNESS_RUNTIME_ENV_NAMES = ['PATH'] as const;

interface HarnessRunResult {
  sessionId: string;
  finalResponse: string;
  finishReason: string | null;
}

interface ResponseTextChunk {
  field: 'text' | 'thinking';
  text: string;
}

interface ResponseRedactionContext {
  pendingText: string;
  pendingChunks: ResponseTextChunk[];
  failClosed: boolean;
}

interface HarnessStreamState {
  initializedSessions: Set<string>;
  sawSessionEvent: boolean;
  sawTextBySession: Set<string>;
  pendingTextDeltasBySession: Set<string>;
  pendingThinkingDeltasBySession: Set<string>;
  responseRedactionContext: ResponseRedactionContext;
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
  /** Attach safe transport metadata; persisted quarantine permits a completed other turn, not a claim of process exit. */
  constructor(
    message: string,
    readonly sdkCode?: string,
    readonly sdkMessage?: string,
    readonly cleanupBarrierPersisted = false,
  ) {
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

class DeepSeekHarnessProviderError extends Error {
  constructor(
    message: string,
    readonly providerCode?: string,
    readonly providerMessage?: string,
  ) {
    super(message);
    this.name = 'DeepSeekHarnessProviderError';
  }
}

interface ResolvedDeepSeekConfiguration {
  provider: string;
  model: string;
  cwd: string;
  systemPrompt?: string;
  maxTokens?: number;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
  reasoningEffort?: DeepSeekReasoningEffort;
}

interface CredentialFailureContext {
  sourceHomeOrigin?: DeepSeekCredentialHomeOrigin;
  reference?: string;
}

interface ProcessEnvironmentResolution {
  env: NodeJS.ProcessEnv;
  knownSecrets: Record<string, string>;
  nestedObservabilityFingerprint: string;
}

/** Recognize JSON objects while excluding null and arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reject malformed protocol objects using a fixed field description. */
function requireRecord(value: unknown, description: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new DeepSeekHarnessProtocolError(`DeepSeek Harness returned a malformed ${description}`);
  }
  return value;
}

/** Validate protocol text before event normalization. */
function requireString(value: unknown, description: string): string {
  if (typeof value !== 'string') {
    throw new DeepSeekHarnessProtocolError(`DeepSeek Harness returned a malformed ${description}`);
  }
  return value;
}

/** Resolve bounded timeout/token options without zero or integer overflow. */
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

/** Read cancellation state without requiring a caller-provided signal. */
function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Resolve ancestor symlinks while preserving a not-yet-created path tail. */
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

/** Reject unsafe SDK IDs before using them in runtime state or output. */
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

/** Prevent identifiers from carrying credentials into non-text stream fields. */
function assertOpaqueProtocolIdentifier(
  identifier: string,
  knownSecrets: Record<string, string>,
  description: string,
): void {
  if (sanitizeKnownSecrets(identifier, knownSecrets) !== identifier) {
    throw new Error(`DeepSeek Harness ${description} must not contain configured secret values`);
  }
}

/** Enforce credential-safe session IDs without rewriting their identity. */
function assertOpaqueSessionId(
  sessionId: string | undefined,
  knownSecrets: Record<string, string>,
): void {
  if (sessionId !== undefined) {
    assertOpaqueProtocolIdentifier(sessionId, knownSecrets, 'sessionId');
  }
}

/** Refuse credential-bearing tool IDs without breaking call/result correlation. */
function assertOpaqueToolId(id: string, knownSecrets: Record<string, string>): void {
  assertOpaqueProtocolIdentifier(id, knownSecrets, 'tool ID');
}

/** Build the supported provider configuration before process creation. */
function resolveDeepSeekConfiguration(
  options: DeepSeekHarnessCallOptions,
  providerOptions: DeepSeekHarnessProviderOptions | undefined,
): ResolvedDeepSeekConfiguration {
  const modelReference = options.model ?? DEEPSEEK_HARNESS_DEFAULT_MODEL;
  const { provider, model } = parseDeepSeekHarnessModelReference(modelReference);
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
  const reasoningEffort = providerOptions?.reasoningEffort;
  if (reasoningEffort !== undefined && !['off', 'low', 'high', 'max'].includes(reasoningEffort)) {
    throw new Error(`Invalid DeepSeek reasoning_effort ${JSON.stringify(reasoningEffort)}; expected off, low, high, or max`);
  }
  return {
    provider,
    model,
    cwd,
    ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    requestTimeoutMs,
    shutdownTimeoutMs,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}

interface ConfiguredDeepSeekCredential {
  referenceValue: string | undefined;
  baseUrl: string | undefined;
}

/** Resolve the environment credential without opening the secret store. */
function resolveConfiguredDeepSeekCredential(
  providerOptions: DeepSeekHarnessProviderOptions | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
  reference: string,
): ConfiguredDeepSeekCredential {
  return {
    referenceValue: childProcessEnv?.[reference] ?? process.env[reference],
    baseUrl: resolveConfiguredDeepSeekEndpoint({ providerOptions, childProcessEnv, ambientEnv: process.env }),
  };
}

/** Collect available environment secrets solely for output redaction. */
function resolveKnownSecrets(
  providerOptions: DeepSeekHarnessProviderOptions | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
  reference: string,
): Record<string, string> {
  const configured = resolveConfiguredDeepSeekCredential(providerOptions, childProcessEnv, reference);
  return {
    ...(configured.referenceValue === undefined ? {} : { [reference]: configured.referenceValue }),
    ...(configured.baseUrl === undefined ? {} : { DEEPSEEK_BASE_URL: configured.baseUrl }),
  };
}

// URL validation can fail before the process record exists; retain raw configured values so
// reporting that failure does not throw again before the redactor can sanitize it.
/** Build redaction context even when setup fails before runtime creation. */
function resolveKnownSecretsForFailure(
  providerOptions: DeepSeekHarnessProviderOptions | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const configured = resolveConfiguredDeepSeekCredential(
    providerOptions,
    childProcessEnv,
    DEEPSEEK_HARNESS_DEFAULT_CREDENTIAL_REFERENCE,
  );
  return {
    ...(configured.referenceValue === undefined
      ? {}
      : { [DEEPSEEK_HARNESS_DEFAULT_CREDENTIAL_REFERENCE]: configured.referenceValue }),
    ...(configured.baseUrl === undefined ? {} : { DEEPSEEK_BASE_URL: configured.baseUrl }),
  };
}

/** Snapshot defined environment values for deterministic credential binding. */
function getAmbientEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

/** Include nested-observability settings in runtime reuse compatibility. */
function getProcessNestedObservabilityFingerprint(
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): string {
  return getNestedObservabilityEnvFingerprint(childProcessEnv ?? getAmbientEnvironment());
}

/** Separate credential source from runtime home and disable unsafe SDK logs. */
function resolveProcessEnvironment(
  providerOptions: DeepSeekHarnessProviderOptions | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
  dshHomeDir: string,
  credentialReference: string,
): ProcessEnvironmentResolution {
  const env: NodeJS.ProcessEnv = {};
  for (const name of DEEPSEEK_HARNESS_RUNTIME_ENV_NAMES) {
    const value = childProcessEnv?.[name] ?? process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  Object.assign(env, pickNestedObservabilityEnv(childProcessEnv ?? getAmbientEnvironment()));

  // Only the selected reference is propagated: an unselected credential variable must
  // never stand in for the reference the settings selector chose.
  const referenceValue = childProcessEnv?.[credentialReference] ?? process.env[credentialReference];
  const configuredBaseUrl = resolveConfiguredDeepSeekEndpoint({ providerOptions, childProcessEnv, ambientEnv: process.env });
  if (configuredBaseUrl !== undefined) {
    env.DEEPSEEK_BASE_URL = configuredBaseUrl;
  }
  if (referenceValue !== undefined) {
    env[credentialReference] = referenceValue;
  }
  env.DSH_HOME = dshHomeDir;
  return {
    env,
    knownSecrets: resolveKnownSecrets(providerOptions, childProcessEnv, credentialReference),
    nestedObservabilityFingerprint: getProcessNestedObservabilityFingerprint(childProcessEnv),
  };
}

/** Canonicalize key order for stable runtime configuration fingerprints. */
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

/**
 * Identify a live SDK configuration without embedding credential values.
 */
function processKey(
  configuration: ResolvedDeepSeekConfiguration,
  providerOptions: DeepSeekHarnessProviderOptions | undefined,
  environment: ProcessEnvironmentResolution,
  binding: DeepSeekCredentialBinding,
): string {
  const { systemPrompt, ...identityConfiguration } = configuration;
  const secretFingerprint = createHash('sha256')
    .update(JSON.stringify(environment.knownSecrets))
    .digest('hex');
  const nonSecretProviderOptions = Object.fromEntries(
    Object.entries(providerOptions ?? {})
      .filter(([name, value]) => value !== undefined && name !== 'baseUrl'),
  );
  return JSON.stringify({
    configuration: identityConfiguration,
    ...(systemPrompt === undefined
      ? {}
      : { systemPromptFingerprint: createHash('sha256').update(systemPrompt).digest('hex') }),
    providerOptions: stableValue(nonSecretProviderOptions),
    secretFingerprint,
    credentialFingerprint: binding.fingerprint,
    nestedObservabilityFingerprint: environment.nestedObservabilityFingerprint,
  });
}

/** Remove known secret values and credential fields from complete text. */
function sanitizeKnownSecrets(text: string, knownSecrets: Record<string, string>): string {
  let sanitized = sanitizeSensitiveTextWithKnownValues(text, knownSecrets);
  for (const value of Object.values(knownSecrets)
    .filter((candidate) => candidate.length > 0)
    .sort((left, right) => right.length - left.length)) {
    sanitized = sanitized.split(value).join('[REDACTED]');
  }
  return sanitized;
}

/** Convert diagnostic values into redacted, control-character-safe text. */
function safeMessage(value: unknown, knownSecrets: Record<string, string>): string {
  const sanitized = sanitizeTerminalText(
    sanitizeKnownSecrets(getErrorMessage(value), knownSecrets),
  );
  if (Buffer.byteLength(sanitized, 'utf8') <= DEEPSEEK_HARNESS_MAX_ERROR_BYTES) {
    return sanitized;
  }
  return `${Buffer.from(sanitized).subarray(0, DEEPSEEK_HARNESS_MAX_ERROR_BYTES).toString('utf8')}...`;
}

/** Retain a possible secret prefix at a chunk boundary until more text arrives. */
function longestKnownSecretPrefixSuffix(
  text: string,
  knownSecrets: Record<string, string>,
): string {
  let longest = '';
  for (const value of Object.values(knownSecrets)) {
    if (value.length < 2) {
      continue;
    }
    const maximumLength = Math.min(value.length - 1, text.length);
    for (let length = maximumLength; length > longest.length; length -= 1) {
      const suffix = value.slice(0, length);
      if (text.endsWith(suffix)) {
        longest = suffix;
        break;
      }
    }
  }
  return longest;
}

/** Detect credential-field boundaries requiring buffered redaction. */
function hasSensitiveCredentialBoundary(text: string): boolean {
  return /(?:api[_-]?key|token|password|secret|credential|authorization|cookie|session[_-]?id)(?:\s*[:=]|\s*$)/iu.test(text);
}

/** Emit only safe buffered text, preserving channels and possible secret suffixes. */
function drainResponseRedactedChunks(
  context: ResponseRedactionContext,
  knownSecrets: Record<string, string>,
  length = context.pendingText.length,
): ResponseTextChunk[] {
  const { values, exhausted } = collectSensitiveStringValues(knownSecrets);
  context.failClosed ||= exhausted;
  if (context.failClosed) {
    const chunks = context.pendingChunks.map((chunk) => ({ field: chunk.field, text: '[REDACTED]' }));
    context.pendingText = '';
    context.pendingChunks = [];
    return chunks;
  }
  collectEmbeddedSensitiveValues(context.pendingText, values);
  // Mark source positions before replacing secrets: a replacement may span
  // several chunks, but safe text must stay in the stream that produced it.
  const sensitive = new Uint8Array(context.pendingText.length);
  for (const value of values) {
    if (value.length === 0) continue;
    let offset = context.pendingText.indexOf(value);
    while (offset >= 0) {
      sensitive.fill(1, offset, offset + value.length);
      offset = context.pendingText.indexOf(value, offset + 1);
    }
  }
  // Never drain half of a redacted value and leave its unrecognizable suffix.
  while (length > 0 && sensitive[length - 1] === 1 && sensitive[length] === 1) length -= 1;
  let offset = 0;
  const chunks: ResponseTextChunk[] = [];
  const pendingChunks: ResponseTextChunk[] = [];
  for (const chunk of context.pendingChunks) {
    const consumed = Math.min(chunk.text.length, Math.max(0, length - offset));
    let text = '';
    let redacting = false;
    for (let index = 0; index < consumed; index += 1) {
      const redact = sensitive[offset + index] === 1;
      if (redact) {
        if (!redacting) text += '[REDACTED]';
      } else {
        text += chunk.text[index];
      }
      redacting = redact;
    }
    if (text.length > 0) chunks.push({ field: chunk.field, text });
    if (consumed < chunk.text.length) {
      pendingChunks.push({ field: chunk.field, text: chunk.text.slice(consumed) });
    }
    offset += chunk.text.length;
  }
  context.pendingText = context.pendingText.slice(length);
  context.pendingChunks = pendingChunks;
  return chunks;
}

/** Convert a redacted text/thinking chunk into a provider-neutral event. */
function responseTextEvent(chunk: ResponseTextChunk): StreamEvent {
  return chunk.field === 'text'
    ? { type: 'text', data: { text: chunk.text } }
    : { type: 'thinking', data: { thinking: chunk.text } };
}

/** Buffer text so credentials split across notifications remain redacted. */
function writeResponseRedactedChunks(
  context: ResponseRedactionContext,
  text: string,
  field: ResponseTextChunk['field'],
  knownSecrets: Record<string, string>,
): ResponseTextChunk[] {
  const combined = context.pendingText + text;
  context.pendingText = combined;
  const previous = context.pendingChunks.at(-1);
  if (previous?.field === field) {
    previous.text += text;
  } else {
    context.pendingChunks.push({ field, text });
  }
  context.failClosed ||= combined.length > DEEPSEEK_HARNESS_MAX_PENDING_RESPONSE_LENGTH
    && (Object.values(knownSecrets).some((value) => value.length > 0) || hasPotentialSensitiveTextSuffix(combined));
  if (context.failClosed) return drainResponseRedactedChunks(context, knownSecrets);
  const knownPrefixSuffix = longestKnownSecretPrefixSuffix(combined, knownSecrets);
  const containsKnownSecret = Object.values(knownSecrets)
    .some((value) => value.length > 0 && combined.includes(value));
  const shouldHold = knownPrefixSuffix.length > 0
    || (
      !containsKnownSecret
      && hasSensitiveCredentialBoundary(combined)
      && hasPotentialSensitiveTextSuffix(combined)
    );
  if (!shouldHold) {
    return drainResponseRedactedChunks(context, knownSecrets);
  }
  if (Object.values(knownSecrets).some((value) => value.length > 0)) {
    const retainedLength = Math.max(SENSITIVE_TEXT_BOUNDARY_WINDOW, knownPrefixSuffix.length);
    return drainResponseRedactedChunks(context, knownSecrets, Math.max(0, combined.length - retainedLength));
  }
  return [];
}

/** Redact final values against unfinished streamed credential boundaries. */
function redactCrossBoundaryFinalValue(
  value: string,
  pendingText: string,
  knownSecrets: Record<string, string>,
): string {
  let continuationLength = 0;
  for (const secret of Object.values(knownSecrets)) {
    if (secret.length < 2) {
      continue;
    }
    for (let split = 1; split < secret.length; split += 1) {
      if (
        pendingText.endsWith(secret.slice(0, split))
        && value.startsWith(secret.slice(split))
      ) {
        continuationLength = Math.max(continuationLength, secret.length - split);
      }
    }
  }
  if (continuationLength > 0) {
    return '[REDACTED]' + sanitizeSensitiveTextWithKnownValues(
      value.slice(continuationLength),
      knownSecrets,
    );
  }
  const combined = pendingText + value;
  if (
    pendingText.length > 0
    && sanitizeSensitiveTextWithKnownValues(pendingText, knownSecrets) === pendingText
    && sanitizeSensitiveTextWithKnownValues(combined, knownSecrets) !== combined
  ) {
    return '[REDACTED]';
  }
  return sanitizeSensitiveTextWithKnownValues(value, knownSecrets);
}

/** Deliver sanitized events while preserving already-validated opaque identifier fields. */
function invokeStream(
  onStream: StreamCallback | undefined,
  event: StreamEvent,
  knownSecrets: Record<string, string>,
  preserveValidatedField?: 'sessionId' | 'id',
  responseRedactionContext?: ResponseRedactionContext,
  streamField?: 'text' | 'thinking',
): void {
  if (responseRedactionContext !== undefined && streamField !== undefined) {
    const eventData = event.data as unknown as Record<string, unknown>;
    const streamValue = eventData[streamField];
    if (typeof streamValue === 'string') {
      const chunks = writeResponseRedactedChunks(responseRedactionContext, streamValue, streamField, knownSecrets);
      for (const chunk of chunks) {
        invokeStream(onStream, responseTextEvent(chunk), knownSecrets);
      }
      return;
    }
  }
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

/** Flush buffered text on completion/failure with conservative redaction. */
function flushHarnessResponseRedactor(
  state: HarnessStreamState,
  onStream: StreamCallback | undefined,
  knownSecrets: Record<string, string>,
  discardPending = false,
): void {
  const context = state.responseRedactionContext;
  const hadPending = context.pendingText.length > 0;
  const hasKnownSecretPending = hadPending
    && longestKnownSecretPrefixSuffix(context.pendingText, knownSecrets).length > 0;
  if (hasKnownSecretPending && !discardPending) {
    return;
  }
  if (discardPending && hadPending) {
    context.pendingText = '';
    context.pendingChunks = [];
    return;
  }
  for (const chunk of drainResponseRedactedChunks(context, knownSecrets)) {
    invokeStream(onStream, responseTextEvent(chunk), knownSecrets);
  }
}

/** Sanitize the final SDK response independently of streamed delivery. */
function redactFinalResponse(
  context: ResponseRedactionContext,
  value: string,
  knownSecrets: Record<string, string>,
): string {
  const finalResponse = redactCrossBoundaryFinalValue(value, context.pendingText, knownSecrets);
  context.pendingText = '';
  context.pendingChunks = [];
  return finalResponse;
}

/** Require an SDK event data object before reading type-specific fields. */
function eventData(event: Record<string, unknown>): Record<string, unknown> {
  return requireRecord(event.data, 'session event data');
}

/** Validate structured SDK content blocks instead of trusting arbitrary payloads. */
function contentBlocks(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new DeepSeekHarnessProtocolError('DeepSeek Harness returned malformed content blocks');
  }
  return value;
}

/** Extract text blocks for provider-neutral tool output. */
function textFromContentBlocks(value: unknown): string {
  return contentBlocks(value)
    .filter((block) => block.type === 'text')
    .map((block) => requireString(block.text, 'text content block'))
    .join('');
}

/** Decode tool arguments into a validated object or fixed protocol failure. */
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

/** Construct a correlated invocation event from validated SDK fields. */
function toolUseEvent(
  id: string,
  name: string,
  input: Record<string, unknown>,
): StreamEvent {
  return { type: 'tool_use', data: { id, tool: name, input } };
}

/** Construct a result preserving its invocation ID and error flag. */
function toolResultEvent(id: string, content: string, isError: boolean): StreamEvent {
  return { type: 'tool_result', data: { id, content, isError } };
}

/** Record fixed failure evidence without retaining credential-bearing upstream details. */
function recordFailureReason(state: HarnessStreamState, _reason: Record<string, unknown>): void {
  state.failureReason = 'DeepSeek Harness turn ended with an error';
}

/** Translate SDK turn events into redacted TAKT text, thinking, tool and end events. */
function normalizeHarnessEvent(
  sessionId: string,
  event: Record<string, unknown>,
  state: HarnessStreamState,
  onStream: StreamCallback | undefined,
  knownSecrets: Record<string, string>,
): void {
  state.sawSessionEvent = true;
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
        invokeStream(
          onStream,
          { type: 'text', data: { text } },
          knownSecrets,
          undefined,
          state.responseRedactionContext,
          'text',
        );
      }
    } else if (chunkType === 'reasoning-delta') {
      const thinking = requireString(chunk.text, 'assistant reasoning delta');
      if (thinking.length > 0) {
        state.pendingThinkingDeltasBySession.add(sessionId);
        invokeStream(
          onStream,
          { type: 'thinking', data: { thinking } },
          knownSecrets,
          undefined,
          state.responseRedactionContext,
          'thinking',
        );
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
      invokeStream(
        onStream,
        { type: 'text', data: { text } },
        knownSecrets,
        undefined,
        state.responseRedactionContext,
        'text',
      );
    }
    const hasThinkingDelta = state.pendingThinkingDeltasBySession.delete(sessionId);
    const thinking = blocks
      .filter((block) => block.type === 'reasoning')
      .map((block) => requireString(block.text, 'reasoning content block'))
      .join('');
    if (!hasThinkingDelta && thinking.length > 0) {
      invokeStream(
        onStream,
        { type: 'thinking', data: { thinking } },
        knownSecrets,
        undefined,
        state.responseRedactionContext,
        'thinking',
      );
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
    state.finishReason = requireString(reason.kind, 'turn end reason kind');
    if (state.finishReason === 'error') {
      recordFailureReason(state, reason);
    }
    flushHarnessResponseRedactor(state, onStream, knownSecrets);
  }
}

/** Route known notifications after validating their session identity. */
function normalizeHarnessNotification(
  notification: HarnessNotification,
  state: HarnessStreamState,
  onStream: StreamCallback | undefined,
  model: string,
  knownSecrets: Record<string, string>,
): void {
  const method = requireString(notification.method, 'notification method');
  if (method !== 'session.started' && method !== 'session.event' && method !== 'session.status') {
    return;
  }
  const payload = requireRecord(notification.params, 'session notification payload');
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
  private closed = false;
  activeTurns = 1;
  lastUsed = ++runtimeUseSequence;
  sessionId: string | undefined;
  private readonly cleanupConfirmationPath: string;

  /** Configure the stock SDK with the managed supervisor executable, credential patch and per-instance exit receipt. */
  constructor(
    private readonly configuration: ResolvedDeepSeekConfiguration,
    private readonly environment: ProcessEnvironmentResolution,
    private readonly credentialPatch: DeepSeekCredentialPatch,
    readonly identity: string,
    readonly credentialFingerprint: string,
    private readonly modules: ManagedDeepSeekHarnessModules,
  ) {
    const runtimePaths = getDeepSeekRuntimePaths();
    this.cleanupConfirmationPath = path.join(path.dirname(credentialPatch.path), 'runtime-exit-confirmed');
    const supervisorPath = fileURLToPath(new URL('./runtime-supervisor.mjs', import.meta.url));
    const env: NodeJS.ProcessEnv = {
      ...environment.env,
      TAKT_DSH_OWNER_DIRECTORY: runtimePaths.owners,
      TAKT_DSH_STATE_DIRECTORY: runtimePaths.state,
      TAKT_DSH_PARENT_PID: String(process.pid),
      TAKT_DSH_CLEANUP_CONFIRMATION: this.cleanupConfirmationPath,
      TAKT_DSH_MANAGED_PACKAGE_DIRECTORY: modules.directory,
    };
    this.harness = new modules.sdk.DeepSeekHarness({
      dshBin: supervisorPath,
      profile: 'sdk',
      patches: [credentialPatch.path],
      dshHome: runtimePaths.dshHome,
      processCwd: configuration.cwd,
      env,
      initializeTimeoutMs: DEEPSEEK_HARNESS_STARTUP_TIMEOUT_MS,
      requestTimeoutMs: configuration.requestTimeoutMs,
      shutdownTimeoutMs: configuration.shutdownTimeoutMs,
      disposeEofGraceMs: DEEPSEEK_HARNESS_SHUTDOWN_TIMEOUT_MS,
      disposeGraceMs: DEEPSEEK_HARNESS_SHUTDOWN_TIMEOUT_MS,
      cwd: configuration.cwd,
      provider: configuration.provider,
      model: configuration.model,
      ...(configuration.maxTokens === undefined ? {} : { maxTokens: configuration.maxTokens }),
      ...(configuration.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: modules.llm.ReasoningEffortId(configuration.reasoningEffort) }),
    });
  }

  private readonly harness: DeepSeekHarness;

  get isClosed(): boolean {
    return this.closed;
  }

  get knownSecrets(): Record<string, string> {
    return this.environment.knownSecrets;
  }

  /** Start under the durable gate and clean up failed initialization. */
  async start(abortSignal?: AbortSignal): Promise<void> {
    if (this.closed) throw new this.modules.sdk.TransportClosedError('closed');
    if (isAbortSignalAborted(abortSignal)) throw abortError(abortSignal?.reason);
    let failureCleanupError: Error | undefined;
    try {
      await withDeepSeekRuntimeCreation(
        async () => {
          if (isAbortSignalAborted(abortSignal)) throw abortError(abortSignal?.reason);
          await waitForAbortable(this.harness.start(), abortSignal);
        },
        async () => {
          if (this.closed) return true;
          try {
            await this.harness.close();
          } catch {
            if (!(await this.hasCleanupConfirmation())) return false;
          }
          this.closed = true;
          try {
            await this.credentialPatch.dispose();
          } catch {
            failureCleanupError = new DeepSeekHarnessTransportError(
              'DeepSeek Harness credential patch cleanup failed.',
              'credential-patch-cleanup-failed',
            );
          }
          return true;
        },
      );
    } catch (error) {
      if (failureCleanupError !== undefined) throw failureCleanupError;
      if (isAbortSignalAborted(abortSignal)) {
        if (!this.closed) await this.close();
        throw abortError(abortSignal?.reason);
      }
      if (error instanceof this.modules.sdk.TransportClosedError) {
        try {
          await assertDeepSeekRuntimeCreationAllowed();
        } catch (gateError) {
          if (gateError instanceof DeepSeekRuntimeBusyError) throw gateError;
          throw new DeepSeekHarnessTransportError(deepSeekCleanupBlockedMessage(), 'cleanup-failed');
        }
      }
      throw mapSdkError(error, this.modules.sdk);
    }
  }

  /** Execute one serialized SDK turn and translate typed upstream failures. */
  async run(
    prompt: string,
    sessionId: string | undefined,
    state: HarnessStreamState,
    onStream: StreamCallback | undefined,
    abortSignal: AbortSignal | undefined,
  ): Promise<HarnessRunResult> {
    await this.start(abortSignal);
    try {
      const result = await waitForAbortable(
        this.harness.run(prompt, {
          ...(sessionId === undefined ? {} : { sessionId }),
          onNotification: (notification) => normalizeHarnessNotification(
            notification,
            state,
            onStream,
            this.configuration.model,
            this.knownSecrets,
          ),
        }),
        abortSignal,
      );
      const activeSessionId = requireString(result.sessionId, 'run result sessionId');
      assertSafeSessionId(activeSessionId);
      assertOpaqueSessionId(activeSessionId, this.knownSecrets);
      if (sessionId !== undefined && activeSessionId !== sessionId) {
        throw new DeepSeekHarnessProtocolError(
          'DeepSeek Harness returned a sessionId different from the requested session',
        );
      }
      const finishReason = state.finishReason ?? null;
      return {
        sessionId: activeSessionId,
        finalResponse: requireString(result.finalResponse, 'run result finalResponse'),
        finishReason,
      };
    } catch (error) {
      if (isAbortSignalAborted(abortSignal)) {
        await this.close();
        throw abortError(abortSignal?.reason);
      }
      throw mapSdkError(error, this.modules.sdk);
    }
  }

  /** Close SDK/patch; failed SDK cleanup carries confirmed quarantine status, while patch cleanup never does. */
  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.harness.close();
    } catch {
      if (!(await this.hasCleanupConfirmation())) {
        let cleanupBarrierPersisted = false;
        try {
          await markDeepSeekCleanupFailure();
          cleanupBarrierPersisted = true;
        } catch {
          // Admission retains its fail-closed lock; do not claim a durable barrier.
        }
        throw new DeepSeekHarnessTransportError(
          deepSeekCleanupBlockedMessage(), 'cleanup-failed', undefined, cleanupBarrierPersisted,
        );
      }
    }
    try {
      await this.credentialPatch.dispose();
    } catch {
      throw new DeepSeekHarnessTransportError(
        'DeepSeek Harness credential patch cleanup failed.',
        'credential-patch-cleanup-failed',
      );
    }
    this.closed = true;
  }

  /** Accept only this instance's supervisor receipt written after proven group exit. */
  private async hasCleanupConfirmation(): Promise<boolean> {
    try {
      return await readFile(this.cleanupConfirmationPath, 'utf8') === 'confirmed\n';
    } catch {
      return false;
    }
  }
}

/** Map SDK error types to fixed diagnostics without exposing raw upstream data. */
function mapSdkError(error: unknown, sdk: ManagedDeepSeekHarnessModules['sdk']): Error {
  if (error instanceof DeepSeekRuntimeBusyError) return error;
  if (error instanceof DeepSeekRuntimeCreationBlockedError) {
    return new DeepSeekHarnessTransportError(deepSeekCleanupBlockedMessage(), 'cleanup-failed');
  }
  if (error instanceof AggregateError) {
    return new DeepSeekHarnessTransportError(deepSeekCleanupBlockedMessage(), 'cleanup-failed');
  }
  if (error instanceof sdk.RequestTimeoutError) {
    return new DeepSeekHarnessTimeoutError('DeepSeek Harness SDK request timed out; the runtime was closed.');
  }
  if (error instanceof sdk.JsonRpcResponseError) {
    if (
      error.code === -32603
      && error.data === undefined
      && /^session "[^"\r\n]+" already exists$/u.test(error.message)
    ) {
      return new DeepSeekHarnessContinuationError();
    }
    return new DeepSeekHarnessProviderError(
      'DeepSeek Harness runtime returned a JSON-RPC error. Upstream error details are withheld.',
      'jsonrpc-error',
      'DeepSeek Harness runtime returned a JSON-RPC error',
    );
  }
  if (error instanceof sdk.SdkProtocolError) {
    return new DeepSeekHarnessProtocolError('DeepSeek Harness SDK protocol validation failed');
  }
  if (error instanceof sdk.TransportClosedError) {
    return new DeepSeekHarnessTransportError(
      'DeepSeek Harness runtime connection closed. Upstream error details are withheld.',
      'transport-closed',
      'DeepSeek Harness runtime connection closed',
    );
  }
  if (error instanceof Error && error.name === 'AbortError') return error;
  return new DeepSeekHarnessTransportError(
    'DeepSeek Harness runtime failed. Upstream error details are withheld.',
    'runtime-failure',
    'DeepSeek Harness runtime failed',
  );
}

interface SessionBinding {
  identity: string;
  credentialFingerprint: string;
}

const processes = new Map<string, DeepSeekHarnessProcess>();
const sessionBindings = new Map<string, SessionBinding>();
const sessionDispatchQueue = createSessionDispatchQueue();
let oneShotProcessSequence = 0;
let runtimeUseSequence = 0;
const MAX_IDLE_RUNTIMES = 8;
const sessionRequests = new Map<string, number>();
let idlePruning: Promise<void> = Promise.resolve();

/** Evict idle runtimes, preserving a completed turn only when failed eviction is durably quarantined. */
async function pruneIdleProcesses(completedProcess: DeepSeekHarnessProcess): Promise<void> {
  const prune = async (): Promise<void> => {
    completedProcess.activeTurns -= 1;
    // A long turn is freshly used when it completes, not an eviction target
    // merely because shorter turns started after it.
    completedProcess.lastUsed = ++runtimeUseSequence;
    while (true) {
      const idle = [...new Set(processes.values())].filter((item) => item.activeTurns === 0
        && (item.sessionId === undefined
          || (sessionRequests.get(item.sessionId) ?? 0) <= (item === completedProcess ? 1 : 0)))
        .sort((left, right) => left.lastUsed - right.lastUsed);
      if (idle.length <= MAX_IDLE_RUNTIMES) return;
      const oldest = idle[0]!;
      removeProcess(oldest);
      try {
        await oldest.close();
      } catch (error) {
        if (error instanceof DeepSeekHarnessTransportError
          && error.sdkCode === 'cleanup-failed'
          && error.cleanupBarrierPersisted) continue;
        throw error;
      }
    }
  };
  const result = idlePruning.then(prune, prune);
  idlePruning = result.catch(() => undefined);
  await result;
}

/** Namespace session keys separately from fresh runtime keys. */
function sessionProcessKey(sessionId: string): string {
  return `session:${createHash('sha256').update(sessionId).digest('hex')}`;
}

/** Remove every cache alias and live credential binding for a disposed runtime. */
function removeProcess(processRecord: DeepSeekHarnessProcess): void {
  for (const [key, value] of processes) {
    if (value === processRecord) processes.delete(key);
  }
  if (processRecord.sessionId !== undefined) sessionBindings.delete(processRecord.sessionId);
}

class DeepSeekHarnessContinuationError extends Error {
  /** Create the fixed unsupported-continuation error without exposing raw SDK history details. */
  constructor() {
    super(deepSeekContinuationMessage());
    this.name = 'DeepSeekHarnessContinuationError';
  }
}

/** Reuse only compatible live sessions; create runtimes only for ID-less requests. */
async function getOrCreateProcess(
  options: DeepSeekHarnessCallOptions,
  credentialFailureContext: CredentialFailureContext,
): Promise<DeepSeekHarnessProcess> {
  assertSupportedDeepSeekHarnessPlatform();
  const managedModules = await loadManagedDeepSeekHarnessModules();
  const providerOptions = options.providerOptions;
  const configuration = resolveDeepSeekConfiguration(options, providerOptions);
  const binding = await resolveDeepSeekCredentialBinding({
    childProcessEnv: options.childProcessEnv,
    ambientEnv: getAmbientEnvironment(),
    userHome: os.homedir(),
    providerOptions,
  });
  credentialFailureContext.sourceHomeOrigin = binding.home.origin;
  credentialFailureContext.reference = binding.ref;
  const runtimePaths = getDeepSeekRuntimePaths();
  const environment = resolveProcessEnvironment(
    providerOptions,
    options.childProcessEnv,
    runtimePaths.dshHome,
    binding.ref,
  );
  assertOpaqueSessionId(options.sessionId, environment.knownSecrets);

  const identity = processKey(configuration, providerOptions, environment, binding);
  const sessionKey = options.sessionId === undefined
    ? `one-shot:${++oneShotProcessSequence}`
    : sessionProcessKey(options.sessionId);

  if (options.sessionId !== undefined) {
    const priorBinding = sessionBindings.get(options.sessionId);
    const priorProcess = processes.get(sessionKey);
    if (priorBinding !== undefined) {
      if (priorBinding.credentialFingerprint !== binding.fingerprint) {
        throw new DeepSeekCredentialDiagnosticError(
          'binding-changed',
          'DeepSeek Harness credential binding changed during this session; start a new run or session',
          { sourceHomeOrigin: binding.home.origin, reference: binding.ref },
        );
      }
      if (priorBinding.identity !== identity) throw new DeepSeekHarnessContinuationError();
      if (priorProcess !== undefined && !priorProcess.isClosed) {
        priorProcess.activeTurns += 1;
        priorProcess.lastUsed = ++runtimeUseSequence;
        return priorProcess;
      }
    }
    // A supplied ID is a continuation request, never permission to mint a new
    // SDK session. Preserve cleanup-barrier diagnostics before refusing it.
    await assertDeepSeekRuntimeCreationAllowed();
    throw new DeepSeekHarnessContinuationError();
  }

  await assertDeepSeekRuntimeCreationAllowed();
  const credentialPatch = await createDeepSeekCredentialPatch(binding, configuration.systemPrompt);
  let processRecord: DeepSeekHarnessProcess | undefined;
  try {
    processRecord = new DeepSeekHarnessProcess(
      configuration,
      environment,
      credentialPatch,
      identity,
      binding.fingerprint,
      managedModules,
    );
    processes.set(sessionKey, processRecord);
    return processRecord;
  } catch (error) {
    if (processRecord !== undefined) removeProcess(processRecord);
    await credentialPatch.dispose().catch(() => undefined);
    throw error;
  }
}

/** Format classified binding failures without reading stored secrets. */
function credentialDiagnosticDetail(
  classification: DeepSeekCredentialFailureClassification,
  errorContext: { sourceHomeOrigin?: DeepSeekCredentialHomeOrigin; reference?: string },
  failureContext: CredentialFailureContext,
): AgentFailureDetail | undefined {
  const sourceHomeOrigin = errorContext.sourceHomeOrigin ?? failureContext.sourceHomeOrigin;
  if (sourceHomeOrigin === undefined) {
    return undefined;
  }
  const reference = errorContext.reference ?? failureContext.reference;
  return createProviderErrorFailure(buildCredentialDiagnostic({
    classification,
    sourceHomeOrigin,
    reference,
  }));
}

/** Recognize only adapter-owned typed, fixed diagnostic evidence. */
function hasSafeRuntimeFailureEvidence(
  evidence: DeepSeekRuntimeFailureEvidence,
  knownSecrets: Record<string, string>,
): boolean {
  const { code, message } = evidence;
  if (
    code === undefined
    || message === undefined
    || code.length === 0
    || message.length === 0
    || Buffer.byteLength(message, 'utf8') > 8 * 1024
    || sanitizeTerminalText(code) !== code
    || sanitizeTerminalText(message) !== message
  ) {
    return false;
  }
  const projected = projectDeepSeekRuntimeMessage(message);
  return projected !== undefined
    && !Object.values(knownSecrets).some((value) => value.length > 0 && projected.includes(value));
}

/** Extract safe evidence without inspecting raw SDK exception causes. */
function runtimeFailureEvidence(
  error: DeepSeekHarnessTransportError | DeepSeekHarnessProviderError,
): DeepSeekRuntimeFailureEvidence {
  return error instanceof DeepSeekHarnessTransportError
    ? { code: error.sdkCode, message: error.sdkMessage }
    : { code: error.providerCode, message: error.providerMessage };
}

/** Classify adapter-owned evidence and leave unknown failures unclassified. */
function safeRuntimeFailureClassification(
  error: DeepSeekHarnessTransportError | DeepSeekHarnessProviderError,
  knownSecrets: Record<string, string>,
): ReturnType<typeof classifyDeepSeekRuntimeFailure> {
  const evidence = runtimeFailureEvidence(error);
  if (!hasSafeRuntimeFailureEvidence(evidence, knownSecrets)) {
    return 'unknown';
  }
  return classifyDeepSeekRuntimeFailure(evidence);
}

/** Preserve terminal failure categories and redact their user-facing diagnostics. */
function failureDetail(
  error: unknown,
  options: DeepSeekHarnessCallOptions,
  knownSecrets: Record<string, string>,
  credentialFailureContext: CredentialFailureContext = {},
): AgentFailureDetail {
  if (error instanceof DeepSeekRuntimeBusyError) {
    return createProviderErrorFailure(error.message);
  }
  if (error instanceof DeepSeekRuntimeCreationBlockedError) {
    return createProviderErrorFailure(deepSeekCleanupBlockedMessage());
  }
  if (error instanceof DeepSeekHarnessInstallRequiredError) {
    return createProviderErrorFailure(error.message);
  }
  if (isAbortSignalAborted(options.abortSignal) || (error instanceof Error && error.name === 'AbortError')) {
    const detail = classifyAbortSignalReason(options.abortSignal?.reason ?? error);
    return { ...detail, reason: safeMessage(detail.reason, knownSecrets) };
  }
  if (
    error instanceof DeepSeekHarnessTimeoutError
    || (error instanceof Error && error.name === 'TimeoutError')
  ) {
    return createPartTimeoutFailure(error.message);
  }
  if (error instanceof DeepSeekHarnessProtocolError) {
    return createProviderStreamParseFailure('DeepSeek Harness SDK protocol validation failed');
  }
  if (error instanceof DeepSeekHarnessContinuationError) {
    return createSessionContinuationUnsupportedFailure(deepSeekContinuationMessage());
  }
  if (error instanceof DeepSeekCredentialDiagnosticError) {
    const diagnostic = credentialDiagnosticDetail(
      error.classification,
      { sourceHomeOrigin: error.sourceHomeOrigin, reference: error.reference },
      credentialFailureContext,
    );
    if (diagnostic !== undefined) {
      if (error.classification === 'binding-changed') {
        return { ...diagnostic, category: AGENT_FAILURE_CATEGORIES.CREDENTIAL_BINDING_CHANGED };
      }
      return diagnostic;
    }
  }
  if (error instanceof DeepSeekHarnessTransportError || error instanceof DeepSeekHarnessProviderError) {
    if (error instanceof DeepSeekHarnessTransportError && error.sdkCode === 'cleanup-failed') {
      return createProviderErrorFailure(deepSeekCleanupBlockedMessage());
    }
    if (error instanceof DeepSeekHarnessProviderError && error.providerCode === 'jsonrpc-error') {
      return createProviderErrorFailure(
        'DeepSeek Harness runtime returned a JSON-RPC error. Upstream error details are withheld.',
      );
    }
    const runtimeClassification = safeRuntimeFailureClassification(
      error,
      knownSecrets,
    );
    if (runtimeClassification !== 'unknown') {
      const evidence = runtimeFailureEvidence(error);
      return createProviderErrorFailure(buildDeepSeekRuntimeFailureDiagnostic(
        runtimeClassification,
        projectDeepSeekRuntimeMessage(evidence.message ?? ''),
      ));
    }
    const classification = classifyDeepSeekRuntimeCredentialFailure(getErrorMessage(error));
    if (classification !== 'unknown') {
      const diagnostic = credentialDiagnosticDetail(classification, {}, credentialFailureContext);
      if (diagnostic !== undefined) {
        return diagnostic;
      }
    }
    const sdkDiagnostic = error instanceof DeepSeekHarnessTransportError
      ? buildDeepSeekSdkFailureDiagnostic(error.sdkCode)
      : undefined;
    if (sdkDiagnostic !== undefined) {
      return createProviderErrorFailure(sdkDiagnostic);
    }
    // Store-only values are deliberately unknown to TAKT. Never expose an
    // unclassified upstream message or stderr tail based on partial redaction.
    return credentialDiagnosticDetail('runtime-failure', {}, credentialFailureContext)
      ?? createProviderErrorFailure('DeepSeek Harness runtime failed; verify credentials and endpoint, then retry.');
  }
  const reason = safeMessage(error, knownSecrets);
  return createProviderErrorFailure(reason);
}

/** Emit terminal failure with the requested session retention policy. */
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

/** Reject missing/unsupported completion evidence instead of reporting success. */
function finishReasonFailure(state: HarnessStreamState): Error {
  const reason = state.failureReason ?? 'DeepSeek Harness turn ended with an error';
  return new DeepSeekHarnessProviderError(reason);
}

/** Validate completion and produce a redacted response before queue release. */
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
    throw new DeepSeekHarnessProtocolError('DeepSeek Harness returned an unsupported turn completion reason');
  }
  const finalResponse = redactFinalResponse(
    state.responseRedactionContext,
    result.finalResponse,
    knownSecrets,
  );
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

/**
 * Capture this turn's options and execute it in session order. Bind an initial
 * runtime to the SDK-returned session before publishing its successful response;
 * terminate failed runtimes before releasing the session queue slot.
 */
export async function callDeepSeekHarness(
  agentType: string,
  prompt: string,
  options: DeepSeekHarnessCallOptions,
): Promise<AgentResponse> {
  const turnOptions: DeepSeekHarnessCallOptions = {
    ...options,
    ...(options.providerOptions === undefined
      ? {}
      : { providerOptions: { ...options.providerOptions } }),
    ...(options.childProcessEnv === undefined
      ? {}
      : { childProcessEnv: { ...options.childProcessEnv } }),
  };
  let processRecord: DeepSeekHarnessProcess | undefined;
  const requestedSessionId = turnOptions.sessionId;
  if (requestedSessionId !== undefined) {
    sessionRequests.set(requestedSessionId, (sessionRequests.get(requestedSessionId) ?? 0) + 1);
  }
  const credentialFailureContext: CredentialFailureContext = {};
  const state: HarnessStreamState = {
    initializedSessions: new Set(),
    sawSessionEvent: false,
    sawTextBySession: new Set(),
    pendingTextDeltasBySession: new Set(),
    pendingThinkingDeltasBySession: new Set(),
    responseRedactionContext: {
      pendingText: '',
      pendingChunks: [],
      failClosed: false,
    },
    emittedToolUses: new Set(),
    emittedToolResults: new Set(),
  };
  try {
    const run = async (): Promise<AgentResponse> => {
      const currentProcess = await getOrCreateProcess(turnOptions, credentialFailureContext);
      processRecord = currentProcess;
      let turnReleased = false;
      try {
        const result = await currentProcess.run(
          prompt,
          requestedSessionId,
          state,
          turnOptions.onStream,
          turnOptions.abortSignal,
        );
        if (requestedSessionId === undefined) {
          if (!(await markDeepSeekSessionUsed(result.sessionId))) {
            throw new DeepSeekHarnessContinuationError();
          }
          const sessionKey = sessionProcessKey(result.sessionId);
          const existingProcess = processes.get(sessionKey);
          if (existingProcess !== undefined && existingProcess !== currentProcess) {
            throw new DeepSeekHarnessContinuationError();
          }
          removeProcess(currentProcess);
          currentProcess.sessionId = result.sessionId;
          processes.set(sessionKey, currentProcess);
          sessionBindings.set(result.sessionId, {
            identity: currentProcess.identity,
            credentialFingerprint: currentProcess.credentialFingerprint,
          });
        }
        // Keep validation and cleanup inside the session queue: the next turn
        // must not acquire this process before its response has been validated.
        // Serialize release and pruning: simultaneous completions must not
        // all observe one another as active and exceed the idle cap.
        turnReleased = true;
        await pruneIdleProcesses(currentProcess);
        return createSuccessResponse(agentType, result, state, turnOptions, currentProcess.knownSecrets);
      } catch (error) {
        try {
          await currentProcess.close();
        } catch (cleanupError) {
          removeProcess(currentProcess);
          throw cleanupError;
        }
        removeProcess(currentProcess);
        throw error;
      } finally {
        if (!turnReleased) currentProcess.activeTurns -= 1;
      }
    };
    const response = requestedSessionId === undefined
      ? await run()
      : await sessionDispatchQueue.run(requestedSessionId, turnOptions.abortSignal, run);
    return response;
  } catch (error) {
    const knownSecrets = processRecord?.knownSecrets
      ?? resolveKnownSecretsForFailure(turnOptions.providerOptions, turnOptions.childProcessEnv);
    flushHarnessResponseRedactor(state, turnOptions.onStream, knownSecrets, true);
    let reportedError = error;
    if (processRecord !== undefined) {
      try {
        await processRecord.close();
      } catch (cleanupError) {
        reportedError = cleanupError;
      }
      removeProcess(processRecord);
    }
    const detail = failureDetail(
      reportedError,
      turnOptions,
      knownSecrets,
      credentialFailureContext,
    );
    const content = formatAgentFailure(detail);
    const responseStatus = error instanceof DeepSeekHarnessTurnEndError
      ? error.responseStatus
      : 'error';
    const preserveRequestedSessionId = requestedSessionId !== undefined
      && (
        processRecord !== undefined
        || detail.category === AGENT_FAILURE_CATEGORIES.SESSION_CONTINUATION_UNSUPPORTED
        || (error instanceof DeepSeekCredentialDiagnosticError && error.classification === 'binding-changed')
      );
    emitFailure(
      turnOptions.onStream,
      content,
      requestedSessionId,
      detail,
      responseStatus,
      knownSecrets,
      preserveRequestedSessionId,
    );
    return {
      persona: agentType,
      status: responseStatus,
      content,
      error: content,
      ...(responseStatus === 'error' ? { failureCategory: detail.category } : {}),
      timestamp: new Date(),
      sessionId: preserveRequestedSessionId ? requestedSessionId : undefined,
    };
  } finally {
    if (requestedSessionId !== undefined) {
      const remaining = (sessionRequests.get(requestedSessionId) ?? 1) - 1;
      if (remaining > 0) sessionRequests.set(requestedSessionId, remaining);
      else sessionRequests.delete(requestedSessionId);
    }
  }
}

/** Close every live SDK runtime while retaining durable session and cleanup markers. */
export async function closeDeepSeekHarnessProcesses(): Promise<void> {
  await idlePruning;
  const active = [...processes.values()];
  processes.clear();
  sessionBindings.clear();
  const results = await Promise.allSettled(active.map((processRecord) => processRecord.close()));
  sessionDispatchQueue.clear();
  if (results.some((result) => result.status === 'rejected')) {
    throw new Error(deepSeekCleanupBlockedMessage());
  }
}
