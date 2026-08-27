import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { parseCanonicalWorkflowResumeFrame } from '../../shared/types/workflow-resume.js';
import type { NdjsonWorkflowStackEntry } from '../../shared/utils/types.js';

const MAX_LOG_EVENTS = 100;
const MAX_HISTORY_EVENTS = 10_000;
const MAX_GRAPH_OCCURRENCES = 10_000;
const MAX_RECORD_BYTES = 1 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 2_000;
const READ_CHUNK_BYTES = 64 * 1024;
const FINGERPRINT_BYTES = 4 * 1024;
const NOFOLLOW = (constants as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW;
const LIFECYCLE_EVENT_TYPES = new Set([
  'step_start',
  'step_complete',
  'phase_start',
  'phase_complete',
  'workflow_call_start',
  'workflow_call_complete',
]);
const OCCURRENCE_START_EVENT_TYPES = new Set(['step_start', 'workflow_call_start']);
const OCCURRENCE_TERMINAL_EVENT_TYPES = new Set(['step_complete', 'workflow_call_complete']);

export interface RunLogEvent {
  readonly type: string;
  readonly timestamp?: string;
  readonly step?: string;
  readonly phase?: number;
  readonly phaseName?: string;
  readonly phaseExecutionId?: string;
  readonly iteration?: number;
  readonly persona?: string;
  readonly workflow?: string;
  readonly childWorkflow?: string;
  readonly callInstance?: string;
  readonly stack?: readonly NdjsonWorkflowStackEntry[];
  readonly status?: string;
  readonly content?: string;
  readonly error?: string;
  readonly reason?: string;
  readonly preview?: string;
  readonly previewTruncated?: boolean;
  readonly occurrenceId?: string;
}

export interface RunLogGraphSummary {
  /**
   * Canonical occurrence snapshots in newest-first order, matching `events`
   * and `history` in the run detail DTO.
   */
  readonly occurrences: readonly RunLogEvent[];
  readonly totalOccurrences: number;
  readonly truncated: boolean;
}

export interface RunLogScanStats {
  readonly bytesRead: number;
  readonly totalBytesRead: number;
  readonly reusedBytes: number;
}

export interface RunLogArtifacts {
  readonly events: readonly RunLogEvent[];
  readonly history: readonly RunLogEvent[];
  readonly historyTruncated: boolean;
  readonly graphSummary: RunLogGraphSummary;
  readonly warnings: readonly string[];
}

export interface RunPromptArtifact {
  readonly timestamp?: string;
  readonly step?: string;
  readonly phase?: number;
  readonly phaseName?: string;
  readonly phaseExecutionId?: string;
  readonly iteration?: number;
  readonly workflow?: string;
  readonly systemPrompt?: string;
  readonly userInstruction?: string;
  readonly instruction?: string;
}

export type RunLogArtifactsDiagnostics = RunLogArtifacts & {
  readonly scan: RunLogScanStats;
};

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface ScannedRecord {
  readonly event: RunLogEvent;
  readonly order: number;
}

interface GraphRecord {
  readonly event: RunLogEvent;
  readonly order: number;
}

export interface RunOccurrenceLifecycle {
  readonly path: string;
  readonly startLine: number;
  readonly endLine?: number;
  /**
   * A second lifecycle boundary reused this identity before the first one
   * closed.  The source range is no longer trustworthy, so prompt reads must
   * fail closed instead of scanning through the later lifecycle.
   */
  readonly ambiguous?: boolean;
}

interface FileFingerprint {
  readonly prefix: Buffer;
  readonly nearOffset: Buffer;
  readonly nearOffsetStart: number;
}

interface SessionLogState {
  readonly path: string;
  identity: FileIdentity;
  size: number;
  modifiedAt: number;
  offset: number;
  decoder: TextDecoder;
  pending: string;
  pendingBytes: number;
  discardingOversize: boolean;
  fingerprint: FileFingerprint;
  events: ScannedRecord[];
  history: ScannedRecord[];
  graph: Map<string, GraphRecord>;
  occurrenceLifecycles: Map<string, RunOccurrenceLifecycle>;
  activeGraphOccurrences: Map<string, string>;
  warnings: string[];
  historyDropped: number;
  graphTotalOccurrences: number;
  error?: Error;
  nextLine: number;
}

interface RunLogCache {
  readonly files: Map<string, SessionLogState>;
  nextOrder: number;
  totalBytesRead: number;
  refreshPromise?: Promise<RunLogScanDelta>;
  lastAccess: number;
}

interface RunLogScanDelta {
  readonly bytesRead: number;
  readonly reusedBytes: number;
}

const caches = new Map<string, RunLogCache>();
let accessCounter = 0;

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function optionalWorkflowStack(
  value: unknown,
): readonly NdjsonWorkflowStackEntry[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Session log workflow stack must be a non-empty array');
  }
  return value.map((frame, index) => parseCanonicalWorkflowResumeFrame(
    frame,
    `Session log workflow stack[${index}]`,
  ));
}

function previewForEvent(event: RunLogEvent): { preview?: string; previewTruncated?: boolean } {
  const value = event.error ?? event.reason ?? event.content;
  if (value === undefined) return {};
  return {
    preview: value.slice(0, MAX_PREVIEW_CHARS),
    previewTruncated: value.length > MAX_PREVIEW_CHARS,
  };
}

function parseLogEvent(value: unknown): RunLogEvent | null {
  const raw = requireRecord(value, 'Session log record');
  if (typeof raw.type !== 'string') return null;
  const event: RunLogEvent = {
    type: raw.type,
    timestamp: [raw.timestamp, raw.endTime, raw.startTime]
      .find((candidate) => typeof candidate === 'string') as string | undefined,
    step: typeof raw.step === 'string' ? raw.step : undefined,
    phase: typeof raw.phase === 'number' ? raw.phase : undefined,
    phaseName: typeof raw.phaseName === 'string' ? raw.phaseName : undefined,
    phaseExecutionId: typeof raw.phaseExecutionId === 'string'
      ? raw.phaseExecutionId
      : undefined,
    iteration: typeof raw.iteration === 'number' ? raw.iteration : undefined,
    persona: typeof raw.persona === 'string' ? raw.persona : undefined,
    workflow: typeof raw.workflow === 'string'
      ? raw.workflow
      : typeof raw.workflowName === 'string' ? raw.workflowName : undefined,
    childWorkflow: typeof raw.childWorkflow === 'string' ? raw.childWorkflow : undefined,
    callInstance: typeof raw.callInstance === 'string'
      ? raw.callInstance
      : typeof raw.callInstance === 'number' && Number.isSafeInteger(raw.callInstance)
        ? String(raw.callInstance)
        : undefined,
    stack: optionalWorkflowStack(raw.stack),
    status: typeof raw.status === 'string' ? raw.status : undefined,
    content: typeof raw.content === 'string' ? raw.content.slice(0, 8_000) : undefined,
    error: typeof raw.error === 'string' ? raw.error.slice(0, 8_000) : undefined,
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 8_000) : undefined,
  };
  return event;
}

function parsePromptArtifact(value: unknown): {
  readonly event: RunLogEvent;
  readonly prompt?: RunPromptArtifact;
} | null {
  const raw = requireRecord(value, 'Session log record');
  const event = parseLogEvent(raw);
  if (event === null || event.type !== 'phase_start') return event === null ? null : { event };
  const prompt = {
    ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
    ...(event.step === undefined ? {} : { step: event.step }),
    ...(event.phase === undefined ? {} : { phase: event.phase }),
    ...(event.phaseName === undefined ? {} : { phaseName: event.phaseName }),
    ...(event.phaseExecutionId === undefined ? {} : { phaseExecutionId: event.phaseExecutionId }),
    ...(event.iteration === undefined ? {} : { iteration: event.iteration }),
    ...(event.workflow === undefined ? {} : { workflow: event.workflow }),
    ...(typeof raw.systemPrompt === 'string' ? { systemPrompt: raw.systemPrompt } : {}),
    ...(typeof raw.userInstruction === 'string' ? { userInstruction: raw.userInstruction } : {}),
    ...(typeof raw.instruction === 'string' ? { instruction: raw.instruction } : {}),
  } satisfies RunPromptArtifact;
  return Object.keys(prompt).some((key) => (
    key === 'systemPrompt' || key === 'userInstruction' || key === 'instruction'
  ))
    ? { event, prompt }
    : { event };
}

function toHistoryEvent(event: RunLogEvent): RunLogEvent {
  return {
    type: event.type,
    ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
    ...(event.step === undefined ? {} : { step: event.step }),
    ...(event.phase === undefined ? {} : { phase: event.phase }),
    ...(event.phaseName === undefined ? {} : { phaseName: event.phaseName }),
    ...(event.phaseExecutionId === undefined ? {} : { phaseExecutionId: event.phaseExecutionId }),
    ...(event.iteration === undefined ? {} : { iteration: event.iteration }),
    ...(event.persona === undefined ? {} : { persona: event.persona }),
    ...(event.workflow === undefined ? {} : { workflow: event.workflow }),
    ...(event.childWorkflow === undefined ? {} : { childWorkflow: event.childWorkflow }),
    ...(event.callInstance === undefined ? {} : { callInstance: event.callInstance }),
    ...(event.stack === undefined ? {} : { stack: event.stack }),
    ...(event.status === undefined ? {} : { status: event.status }),
    ...(event.occurrenceId === undefined ? {} : { occurrenceId: event.occurrenceId }),
    ...previewForEvent(event),
  };
}

function graphOccurrenceBaseKey(event: RunLogEvent): string | null {
  if (event.step === undefined) return null;
  const stack = event.stack?.map((frame) => [
    frame.workflow,
    frame.workflow_ref,
    frame.step,
    frame.kind,
    frame.occurrence,
  ]);
  return JSON.stringify([
    event.workflow,
    event.step,
    event.childWorkflow,
    event.callInstance,
    stack,
  ]);
}

type OccurrenceIdentity = Pick<
  RunLogEvent,
  'step' | 'workflow' | 'childWorkflow' | 'callInstance' | 'iteration' | 'stack'
>;

function optionalIdentityMatches<T>(left: T | undefined, right: T | undefined): boolean {
  return left === undefined || right === undefined || left === right;
}

function occurrenceIdentityMatches(
  candidate: OccurrenceIdentity,
  event: OccurrenceIdentity,
): boolean {
  return candidate.step !== undefined
    && event.step !== undefined
    && candidate.step === event.step
    && optionalIdentityMatches(candidate.workflow, event.workflow)
    && optionalIdentityMatches(candidate.childWorkflow, event.childWorkflow)
    && optionalIdentityMatches(candidate.callInstance, event.callInstance)
    && optionalIdentityMatches(candidate.iteration, event.iteration)
    && (candidate.stack === undefined
      || event.stack === undefined
      || workflowStacksMatch(candidate.stack, event.stack));
}

function isOccurrenceStart(event: RunLogEvent): boolean {
  return OCCURRENCE_START_EVENT_TYPES.has(event.type);
}

function isOccurrenceTerminal(event: RunLogEvent): boolean {
  // Phase completion is progress inside an occurrence; only the lifecycle
  // boundary closes it. Status text alone is not a reliable boundary because
  // providers can report a terminal-looking phase status before step_complete.
  return OCCURRENCE_TERMINAL_EVENT_TYPES.has(event.type);
}

function createState(path: string, identity: FileIdentity, size: number, modifiedAt: number): SessionLogState {
  return {
    path,
    identity,
    size,
    modifiedAt,
    offset: 0,
    decoder: new TextDecoder(),
    pending: '',
    pendingBytes: 0,
    discardingOversize: false,
    fingerprint: {
      prefix: Buffer.alloc(0),
      nearOffset: Buffer.alloc(0),
      nearOffsetStart: 0,
    },
    events: [],
    history: [],
    graph: new Map(),
    occurrenceLifecycles: new Map(),
    activeGraphOccurrences: new Map(),
    warnings: [],
    historyDropped: 0,
    graphTotalOccurrences: 0,
    nextLine: 1,
  };
}

function addWarning(state: SessionLogState, message: string): void {
  const warning = `${state.path}: ${message}`;
  if (!state.warnings.includes(warning)) state.warnings.push(warning);
}

function appendBounded(target: ScannedRecord[], record: ScannedRecord, limit: number): boolean {
  target.push(record);
  if (target.length <= limit) return false;
  target.shift();
  return true;
}

function isCurrentGraphRecord(record: GraphRecord): boolean {
  return !OCCURRENCE_TERMINAL_EVENT_TYPES.has(record.event.type);
}

function evictOldestGraphRecord(state: SessionLogState): void {
  const records = [...state.graph.entries()];
  if (records.length === 0) return;
  const completed = records.filter(([, record]) => !isCurrentGraphRecord(record));
  const candidates = completed.length > 0 ? completed : records;
  const oldest = candidates.reduce((selected, candidate) => (
    selected === undefined || candidate[1].order < selected[1].order ? candidate : selected
  ), undefined as [string, GraphRecord] | undefined);
  if (oldest !== undefined) {
    state.graph.delete(oldest[0]);
    state.occurrenceLifecycles.delete(oldest[0]);
  }
}

function activeOccurrenceCandidates(
  state: SessionLogState,
  event: RunLogEvent,
): readonly [string, string][] {
  const candidates: [string, string][] = [];
  const seen = new Set<string>();
  for (const [baseKey, key] of state.activeGraphOccurrences) {
    const record = state.graph.get(key);
    if (record === undefined
      || seen.has(key)
      || !occurrenceIdentityMatches(record.event, event)) continue;
    seen.add(key);
    candidates.push([baseKey, key]);
  }
  return candidates;
}

function markLifecycleAmbiguous(state: SessionLogState, occurrenceId: string): void {
  const lifecycle = state.occurrenceLifecycles.get(occurrenceId);
  if (lifecycle === undefined || lifecycle.endLine !== undefined || lifecycle.ambiguous === true) return;
  state.occurrenceLifecycles.set(occurrenceId, { ...lifecycle, ambiguous: true });
}

function updateGraph(
  state: SessionLogState,
  event: RunLogEvent,
  order: number,
  line: number,
): string | undefined {
  if (!LIFECYCLE_EVENT_TYPES.has(event.type)) return undefined;
  const baseKey = graphOccurrenceBaseKey(event);
  if (baseKey === null) return undefined;
  const startsOccurrence = isOccurrenceStart(event);
  const candidates = activeOccurrenceCandidates(state, event);
  if (startsOccurrence) {
    // A repeated start before the previous boundary is not enough evidence
    // to infer where the first lifecycle ended. Preserve the old occurrence
    // for graph continuity, but make its prompt scope unusable.
    const exactCandidate = state.activeGraphOccurrences.get(baseKey);
    if (exactCandidate !== undefined) markLifecycleAmbiguous(state, exactCandidate);
    for (const [, candidateKey] of candidates) markLifecycleAmbiguous(state, candidateKey);
  }
  let matchedBaseKey = baseKey;
  let activeKey: string | undefined;
  if (!startsOccurrence) {
    if (candidates.length > 1) {
      // Optional identity fields cannot disambiguate these active lifecycles.
      // Do not manufacture a phantom occurrence or attach to an arbitrary one.
      return undefined;
    }
    if (candidates.length === 1) {
      [matchedBaseKey, activeKey] = candidates[0]!;
    }
  }
  const key = startsOccurrence
    ? `${baseKey}:occurrence:${order}`
    : activeKey ?? `${baseKey}:occurrence:${order}`;
  const previous = state.graph.get(key);
  const nextEvent = {
    ...previous?.event,
    ...toHistoryEvent(event),
    occurrenceId: key,
  };
  if (previous === undefined) {
    // A start record is the canonical occurrence boundary. Completion and
    // phase records update that boundary, but must not inflate the total.
    // A completion-only log is accepted once while there is still capacity.
    if (state.graph.size >= MAX_GRAPH_OCCURRENCES && !OCCURRENCE_START_EVENT_TYPES.has(event.type)) {
      return undefined;
    }
    if (state.graph.size >= MAX_GRAPH_OCCURRENCES) evictOldestGraphRecord(state);
    state.graphTotalOccurrences += 1;
    state.occurrenceLifecycles.set(key, {
      path: state.path,
      startLine: line,
    });
  }
  state.graph.set(key, {
    event: nextEvent,
    order: previous?.order ?? order,
  });
  if (isOccurrenceTerminal(event)) {
    // A phase record with omitted scope may have been matched through an
    // existing full-scope key. Do not leave that partial key as a second
    // active alias; terminal events must retire every alias for this
    // occurrence, including aliases left by older cache state.
    for (const [alias, occurrenceId] of state.activeGraphOccurrences) {
      if (occurrenceId === key) state.activeGraphOccurrences.delete(alias);
    }
    const lifecycle = state.occurrenceLifecycles.get(key);
    if (lifecycle !== undefined) {
      state.occurrenceLifecycles.set(key, { ...lifecycle, endLine: line });
    }
  } else state.activeGraphOccurrences.set(matchedBaseKey, key);
  return key;
}

function acceptEvent(
  state: SessionLogState,
  cache: RunLogCache,
  event: RunLogEvent,
  line: number,
): void {
  const order = cache.nextOrder;
  cache.nextOrder += 1;
  if (LIFECYCLE_EVENT_TYPES.has(event.type)) {
    const occurrenceId = updateGraph(state, event, order, line);
    const annotatedEvent = occurrenceId === undefined ? event : { ...event, occurrenceId };
    appendBounded(state.events, { event: annotatedEvent, order }, MAX_LOG_EVENTS);
    if (appendBounded(state.history, { event: toHistoryEvent(annotatedEvent), order }, MAX_HISTORY_EVENTS)) {
      state.historyDropped += 1;
    }
    return;
  }
  appendBounded(state.events, { event, order }, MAX_LOG_EVENTS);
}

function parseCompleteLine(state: SessionLogState, cache: RunLogCache, line: string): void {
  const lineNumber = state.nextLine;
  state.nextLine += 1;
  if (state.discardingOversize) {
    state.discardingOversize = false;
    return;
  }
  if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) {
    addWarning(state, `record at line ${lineNumber} was truncated because it exceeds 1 MiB`);
    return;
  }
  if (line.length === 0) return;
  try {
    const event = parseLogEvent(JSON.parse(line) as unknown);
    if (event !== null) acceptEvent(state, cache, event, lineNumber);
  } catch (error) {
    if (error instanceof SyntaxError) {
      addWarning(state, `record at line ${lineNumber} was ignored because it is not valid JSON`);
      return;
    }
    // Keep a validation error sticky until the file is replaced or truncated.
    // The scanner has already advanced its byte cursor, so retrying the same
    // file must never present a partially committed snapshot as successful.
    const normalized = error instanceof Error ? error : new Error(String(error));
    state.error = normalized;
    throw normalized;
  }
}

function appendDecoded(state: SessionLogState, cache: RunLogCache, decoded: string): void {
  let start = 0;
  for (let index = 0; index < decoded.length; index += 1) {
    if (decoded[index] !== '\n') continue;
    if (!state.discardingOversize) state.pending += decoded.slice(start, index);
    state.pendingBytes += Buffer.byteLength(decoded.slice(start, index), 'utf8');
    if (!state.discardingOversize && state.pendingBytes > MAX_RECORD_BYTES) {
      state.pending = '';
      state.discardingOversize = true;
      addWarning(state, `record at line ${state.nextLine} was truncated because it exceeds 1 MiB`);
    }
    parseCompleteLine(state, cache, state.discardingOversize ? '' : state.pending);
    state.pending = '';
    state.pendingBytes = 0;
    start = index + 1;
  }
  const remainder = decoded.slice(start);
  if (!state.discardingOversize) {
    state.pending += remainder;
    state.pendingBytes += Buffer.byteLength(remainder, 'utf8');
    if (state.pendingBytes > MAX_RECORD_BYTES) {
      state.pending = '';
      state.discardingOversize = true;
      addWarning(state, `record at line ${state.nextLine} was truncated because it exceeds 1 MiB`);
    }
  }
}

function resetState(state: SessionLogState, identity: FileIdentity, size: number, modifiedAt: number): void {
  Object.assign(state, createState(state.path, identity, size, modifiedAt));
  state.error = undefined;
}

function appendFingerprint(state: SessionLogState, bytes: Buffer): void {
  const prefix = state.fingerprint.prefix.length >= FINGERPRINT_BYTES
    ? state.fingerprint.prefix
    : Buffer.concat([state.fingerprint.prefix, bytes]).subarray(0, FINGERPRINT_BYTES);
  const nearOffset = Buffer.concat([state.fingerprint.nearOffset, bytes]).subarray(-FINGERPRINT_BYTES);
  state.fingerprint = {
    prefix,
    nearOffset,
    nearOffsetStart: Math.max(0, state.offset - nearOffset.length),
  };
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const result = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, result.bytesRead);
}

async function matchesFingerprint(
  handle: FileHandle,
  state: SessionLogState,
): Promise<boolean> {
  const { prefix, nearOffset, nearOffsetStart } = state.fingerprint;
  const currentPrefix = await readAt(handle, 0, prefix.length);
  if (!currentPrefix.equals(prefix)) return false;
  const currentNearOffset = await readAt(handle, nearOffsetStart, nearOffset.length);
  return currentNearOffset.equals(nearOffset);
}

async function openSessionLog(path: string): Promise<FileHandle> {
  if (NOFOLLOW === undefined) throw new Error('Session log cannot be opened safely on this platform');
  const expected = resolve(path);
  if (await realpath(expected) !== expected) throw new Error('Session log contains a symbolic link');
  const handle = await open(expected, constants.O_RDONLY | NOFOLLOW);
  try {
    if (await realpath(expected) !== expected) {
      throw new Error('Session log contains a symbolic link');
    }
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('Session log must be a regular file');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function scanFile(
  cache: RunLogCache,
  path: string,
  verifySnapshot: () => Promise<void>,
): Promise<{ readonly bytesRead: number; readonly reusedBytes: number }> {
  await verifySnapshot();
  const handle = await openSessionLog(path);
  try {
    const stats = await handle.stat();
    const identity = { dev: stats.dev, ino: stats.ino };
    let state = cache.files.get(path);
    const identityChanged = state !== undefined && (
      state.identity.dev !== identity.dev
      || state.identity.ino !== identity.ino
    );
    if (state === undefined) {
      state = createState(path, identity, stats.size, stats.mtimeMs);
      cache.files.set(path, state);
    } else if (identityChanged || stats.size < state.offset) {
      resetState(state, identity, stats.size, stats.mtimeMs);
    } else if (stats.size !== state.size || stats.mtimeMs !== state.modifiedAt) {
      // A same-inode rewrite can grow beyond the old offset. Verify a bounded
      // prefix and the bytes nearest the old cursor before treating it as an
      // append; this also lets a sticky parse error recover after replacement.
      if (!await matchesFingerprint(handle, state)) {
        resetState(state, identity, stats.size, stats.mtimeMs);
      }
    }
    if (state.error !== undefined) throw state.error;
    if (stats.size <= state.offset) {
      state.size = stats.size;
      state.modifiedAt = stats.mtimeMs;
      return { bytesRead: 0, reusedBytes: stats.size };
    }

    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    let bytesRead = 0;
    while (state.offset < stats.size) {
      const length = Math.min(buffer.length, stats.size - state.offset);
      const result = await handle.read(buffer, 0, length, state.offset);
      if (result.bytesRead === 0) break;
      state.offset += result.bytesRead;
      bytesRead += result.bytesRead;
      cache.totalBytesRead += result.bytesRead;
      const chunk = buffer.subarray(0, result.bytesRead);
      appendFingerprint(state, chunk);
      appendDecoded(state, cache, state.decoder.decode(chunk, { stream: true }));
    }
    state.size = state.offset;
    state.modifiedAt = stats.mtimeMs;
    await verifySnapshot();
    return { bytesRead, reusedBytes: Math.max(0, stats.size - bytesRead) };
  } finally {
    await handle.close();
  }
}

function createCache(): RunLogCache {
  return { files: new Map(), nextOrder: 0, totalBytesRead: 0, lastAccess: 0 };
}

function getCache(key: string): RunLogCache {
  const existing = caches.get(key);
  if (existing !== undefined) {
    existing.lastAccess = ++accessCounter;
    return existing;
  }
  const cache = createCache();
  cache.lastAccess = ++accessCounter;
  caches.set(key, cache);
  if (caches.size > 128) {
    const oldest = [...caches.entries()].sort((left, right) => left[1].lastAccess - right[1].lastAccess)[0];
    if (oldest !== undefined) caches.delete(oldest[0]);
  }
  return cache;
}

/**
 * Returns the source log and line boundary assigned while indexing an
 * occurrence. This is kept out of the run-detail DTO and is used only by the
 * on-demand prompt reader; an ambiguous lifecycle is returned explicitly so
 * that reader can fail closed.
 */
export function getRunOccurrenceLifecycle(
  cacheKey: string,
  occurrenceId: string,
): RunOccurrenceLifecycle | undefined {
  const cache = caches.get(cacheKey);
  if (cache === undefined) return undefined;
  let found: RunOccurrenceLifecycle | undefined;
  for (const state of cache.files.values()) {
    const candidate = state.occurrenceLifecycles.get(occurrenceId);
    if (candidate === undefined) continue;
    if (found !== undefined && (
      found.path !== candidate.path
      || found.startLine !== candidate.startLine
      || found.endLine !== candidate.endLine
      || found.ambiguous !== candidate.ambiguous
    )) return undefined;
    found = candidate;
  }
  return found;
}

function refreshCache(
  cache: RunLogCache,
  paths: readonly string[],
  verifySnapshot: () => Promise<void>,
): Promise<RunLogScanDelta> {
  const refresh = async (): Promise<RunLogScanDelta> => {
    const currentPaths = new Set(paths);
    for (const path of cache.files.keys()) {
      if (!currentPaths.has(path)) cache.files.delete(path);
    }
    const results = [];
    for (const path of paths) results.push(await scanFile(cache, path, verifySnapshot));
    return {
      bytesRead: results.reduce((total, result) => total + result.bytesRead, 0),
      reusedBytes: results.reduce((total, result) => total + result.reusedBytes, 0),
    };
  };
  const previous = cache.refreshPromise ?? Promise.resolve({ bytesRead: 0, reusedBytes: 0 });
  const pending = previous.catch(() => ({ bytesRead: 0, reusedBytes: 0 })).then(refresh);
  const completion = pending.finally(() => {
    if (cache.refreshPromise === completion) cache.refreshPromise = undefined;
  });
  cache.refreshPromise = completion;
  return completion;
}

function snapshotArtifacts(cache: RunLogCache): RunLogArtifacts {
  const files = [...cache.files.values()];
  const events = files
    .flatMap((state) => state.events)
    .sort((left, right) => left.order - right.order)
    .slice(-MAX_LOG_EVENTS)
    .reverse()
    .map((record) => record.event);
  const history = files
    .flatMap((state) => state.history)
    .sort((left, right) => left.order - right.order)
    .slice(-MAX_HISTORY_EVENTS)
    .reverse()
    .map((record) => record.event);
  const graphRecords = files
    .flatMap((state) => [...state.graph.values()])
    .sort((left, right) => left.order - right.order);
  const totalOccurrences = files.reduce(
    (total, state) => total + state.graphTotalOccurrences,
    0,
  );
  const graphSummary: RunLogGraphSummary = {
    // All run detail collections are newest-first. Keep the newest canonical
    // occurrences when several log files are combined as well.
    occurrences: graphRecords.slice(-MAX_GRAPH_OCCURRENCES).reverse().map((record) => record.event),
    totalOccurrences,
    truncated: totalOccurrences > Math.min(graphRecords.length, MAX_GRAPH_OCCURRENCES),
  };
  const warnings = files.flatMap((state) => state.warnings);
  const uniqueWarnings = [...new Set(warnings)];
  const historyCount = files.reduce(
    (total, state) => total + state.history.length + state.historyDropped,
    0,
  );
  const historyTruncated = historyCount > MAX_HISTORY_EVENTS;
  return {
    events,
    history,
    historyTruncated,
    graphSummary: {
      ...graphSummary,
    },
    warnings: uniqueWarnings,
  };
}

async function readRunLogArtifactsInternal(
  cacheKey: string,
  paths: readonly string[],
  verifySnapshot: () => Promise<void>,
): Promise<RunLogArtifactsDiagnostics> {
  const cache = getCache(cacheKey);
  const delta = await refreshCache(cache, paths, verifySnapshot);
  return {
    ...snapshotArtifacts(cache),
    scan: {
      bytesRead: delta.bytesRead,
      totalBytesRead: cache.totalBytesRead,
      reusedBytes: delta.reusedBytes,
    },
  };
}

function workflowStacksMatch(
  left: readonly NdjsonWorkflowStackEntry[] | undefined,
  right: readonly NdjsonWorkflowStackEntry[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((frame, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && frame.workflow === candidate.workflow
      && frame.workflow_ref === candidate.workflow_ref
      && frame.step === candidate.step
      && frame.kind === candidate.kind
      && frame.occurrence === candidate.occurrence;
  });
}

function promptBelongsToOccurrence(
  event: RunLogEvent,
  occurrence: Pick<RunLogEvent, 'step' | 'workflow' | 'childWorkflow' | 'callInstance' | 'iteration' | 'stack'>,
): boolean {
  // A phase_start is emitted from the same lifecycle, but older/canonical
  // records do not always repeat every scope field. The lifecycle line range
  // below supplies that missing identity; fields that are present must still
  // agree with the selected occurrence.
  return event.step !== undefined
    && occurrence.step !== undefined
    && event.step === occurrence.step
    && (event.workflow === undefined
      || occurrence.workflow === undefined
      || event.workflow === occurrence.workflow)
    && (event.childWorkflow === undefined
      || occurrence.childWorkflow === undefined
      || event.childWorkflow === occurrence.childWorkflow)
    && (event.callInstance === undefined
      || occurrence.callInstance === undefined
      || event.callInstance === occurrence.callInstance)
    && (event.iteration === undefined
      || occurrence.iteration === undefined
      || event.iteration === occurrence.iteration)
    && (event.stack === undefined
      || occurrence.stack === undefined
      || workflowStacksMatch(event.stack, occurrence.stack));
}

async function readPromptLogFile(
  path: string,
  occurrence: Pick<RunLogEvent, 'step' | 'workflow' | 'childWorkflow' | 'callInstance' | 'iteration' | 'stack'>,
  verifySnapshot: () => Promise<void>,
  prompts: RunPromptArtifact[],
  lifecycle: RunOccurrenceLifecycle,
): Promise<void> {
  await verifySnapshot();
  const handle = await openSessionLog(path);
  try {
    const stats = await handle.stat();
    const decoder = new TextDecoder();
    let offset = 0;
    let pending = '';
    let pendingBytes = 0;
    let discardingOversize = false;

    let lineNumber = 1;
    const consumeLine = (line: string, currentLine: number): void => {
      if (discardingOversize) {
        discardingOversize = false;
        return;
      }
      if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES || line.length === 0) return;
      if (currentLine < lifecycle.startLine
        || (lifecycle.endLine !== undefined && currentLine > lifecycle.endLine)) return;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (error) {
        if (error instanceof SyntaxError) return;
        throw error;
      }
      const parsed = parsePromptArtifact(value);
      if (parsed?.prompt !== undefined && promptBelongsToOccurrence(parsed.event, occurrence)) {
        prompts.push(parsed.prompt);
      }
    };

    const append = (decoded: string): void => {
      let start = 0;
      for (let index = 0; index < decoded.length; index += 1) {
        if (decoded[index] !== '\n') continue;
        if (!discardingOversize) pending += decoded.slice(start, index);
        pendingBytes += Buffer.byteLength(decoded.slice(start, index), 'utf8');
        if (!discardingOversize && pendingBytes > MAX_RECORD_BYTES) {
          pending = '';
          discardingOversize = true;
        }
        consumeLine(discardingOversize ? '' : pending, lineNumber);
        lineNumber += 1;
        pending = '';
        pendingBytes = 0;
        start = index + 1;
      }
      const remainder = decoded.slice(start);
      if (!discardingOversize) {
        pending += remainder;
        pendingBytes += Buffer.byteLength(remainder, 'utf8');
        if (pendingBytes > MAX_RECORD_BYTES) {
          pending = '';
          discardingOversize = true;
        }
      }
    };

    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    while (offset < stats.size) {
      const length = Math.min(buffer.length, stats.size - offset);
      const result = await handle.read(buffer, 0, length, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
      append(decoder.decode(buffer.subarray(0, result.bytesRead), { stream: true }));
    }
    append(decoder.decode());
    if (!discardingOversize && pending.length > 0) consumeLine(pending, lineNumber);
    await verifySnapshot();
  } finally {
    await handle.close();
  }
}

/**
 * Reads prompt bodies only for one already-validated occurrence. Prompt text
 * is intentionally not part of the bounded run-detail cache or SSE snapshot.
 */
export async function readRunOccurrencePrompts(
  paths: readonly string[],
  occurrence: Pick<RunLogEvent, 'step' | 'workflow' | 'childWorkflow' | 'callInstance' | 'iteration' | 'stack'>,
  verifySnapshot: () => Promise<void>,
  lifecycle?: RunOccurrenceLifecycle,
): Promise<readonly RunPromptArtifact[]> {
  // Prompt scope is intentionally fail-closed when the occurrence's source
  // and lifecycle boundary are unavailable. Matching values across all logs
  // is not sufficient to distinguish repeated executions.
  if (
    lifecycle === undefined
    || lifecycle.ambiguous === true
    || !paths.includes(lifecycle.path)
  ) return [];
  const prompts: RunPromptArtifact[] = [];
  await readPromptLogFile(lifecycle.path, occurrence, verifySnapshot, prompts, lifecycle);
  return prompts
    .map((prompt, index) => ({ prompt, index }))
    .sort((left, right) => {
      const timestampOrder = (left.prompt.timestamp ?? '').localeCompare(right.prompt.timestamp ?? '');
      if (timestampOrder !== 0) return timestampOrder;
      const phaseOrder = (left.prompt.phase ?? Number.MAX_SAFE_INTEGER)
        - (right.prompt.phase ?? Number.MAX_SAFE_INTEGER);
      return phaseOrder || left.index - right.index;
    })
    .map(({ prompt }) => prompt);
}

export async function readRunLogArtifacts(
  cacheKey: string,
  paths: readonly string[],
  verifySnapshot: () => Promise<void>,
): Promise<RunLogArtifacts> {
  const diagnostics = await readRunLogArtifactsInternal(
    cacheKey,
    paths,
    verifySnapshot,
  );
  return {
    events: diagnostics.events,
    history: diagnostics.history,
    historyTruncated: diagnostics.historyTruncated,
    graphSummary: diagnostics.graphSummary,
    warnings: diagnostics.warnings,
  };
}

/**
 * Test/diagnostic seam for proving incremental scanning without exposing
 * implementation counters through the Web UI run detail DTO.
 */
export async function readRunLogArtifactsForDiagnostics(
  cacheKey: string,
  paths: readonly string[],
  verifySnapshot: () => Promise<void>,
): Promise<RunLogArtifactsDiagnostics> {
  return readRunLogArtifactsInternal(cacheKey, paths, verifySnapshot);
}
