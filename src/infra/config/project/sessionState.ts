import { join } from 'node:path';
import {
  PrivateArtifactPublicationConflictError,
  readPrivateFileState,
  writePrivateFileWithModeExpected,
  type PrivateFileState,
} from '../../../shared/utils/private-file.js';
import { getProjectConfigDir, ensureDir } from '../paths.js';

const SESSION_STATE_MODE = 0o600;
const LEGACY_SESSION_STATE_PUBLICATION_ID = 'legacy-session-state';

export interface SessionState {
  readonly status: 'success' | 'error' | 'user_stopped';
  readonly taskResult?: string;
  readonly errorMessage?: string;
  readonly timestamp: string;
  readonly workflowName: string;
  readonly taskContent?: string;
  readonly lastStep?: string;
}

interface SessionStateEnvelope {
  readonly version: 1;
  readonly publicationId: string;
  readonly status: 'pending' | 'consumed';
  readonly state: SessionState;
  readonly consumedAt?: string;
}

export function getSessionStatePath(projectDir: string, storageDirectory?: string): string {
  return join(storageDirectory ?? getProjectConfigDir(projectDir), 'session-state.json');
}

export function saveSessionState(
  projectDir: string,
  publicationId: string,
  state: SessionState,
  storageDirectory?: string,
): void {
  assertPublicationId(publicationId);
  assertSessionState(state);
  mutateSessionState(projectDir, (current) => {
    if (current === undefined) {
      return pendingEnvelope(publicationId, state);
    }
    if (current.envelope.publicationId === publicationId) {
      if (!sameSessionState(current.envelope.state, state)) {
        throw new Error(
          `Session state publication "${publicationId}" conflicts with stored content`,
        );
      }
      return undefined;
    }
    if (compareSessionStateOrder(
      state,
      publicationId,
      current.envelope.state,
      current.envelope.publicationId,
    ) <= 0) {
      return undefined;
    }
    return pendingEnvelope(publicationId, state);
  }, storageDirectory);
}

export function takeSessionState(projectDir: string, storageDirectory?: string): SessionState | null {
  const directory = storageDirectory ?? getProjectConfigDir(projectDir);
  ensureDir(directory);
  const path = getSessionStatePath(projectDir, storageDirectory);
  while (true) {
    const snapshot = readPrivateFileState(path);
    if (!snapshot.state.exists) {
      return null;
    }
    const envelope = parseSessionStateEnvelope(
      requireSnapshotContent(snapshot, path).toString('utf-8'),
    );
    if (envelope.status === 'consumed') {
      return null;
    }
    const consumed: SessionStateEnvelope = {
      ...envelope,
      status: 'consumed',
      consumedAt: new Date().toISOString(),
    };
    try {
      writePrivateFileWithModeExpected(
        path,
        `${JSON.stringify(consumed, null, 2)}\n`,
        SESSION_STATE_MODE,
        snapshot.state,
      );
      return envelope.state;
    } catch (error) {
      if (error instanceof PrivateArtifactPublicationConflictError) {
        continue;
      }
      throw error;
    }
  }
}

function mutateSessionState(
  projectDir: string,
  mutation: (
    current: {
      readonly envelope: SessionStateEnvelope;
      readonly state: Extract<PrivateFileState, { exists: true }>;
    } | undefined,
  ) => SessionStateEnvelope | undefined,
  storageDirectory?: string,
): void {
  const directory = storageDirectory ?? getProjectConfigDir(projectDir);
  ensureDir(directory);
  const path = getSessionStatePath(projectDir, storageDirectory);
  while (true) {
    const snapshot = readPrivateFileState(path);
    const current = snapshot.state.exists
      ? {
          envelope: parseSessionStateEnvelope(
            requireSnapshotContent(snapshot, path).toString('utf-8'),
          ),
          state: snapshot.state,
        }
      : undefined;
    const next = mutation(current);
    if (next === undefined) {
      return;
    }
    try {
      writePrivateFileWithModeExpected(
        path,
        `${JSON.stringify(next, null, 2)}\n`,
        SESSION_STATE_MODE,
        snapshot.state,
      );
      return;
    } catch (error) {
      if (error instanceof PrivateArtifactPublicationConflictError) {
        continue;
      }
      throw error;
    }
  }
}

function pendingEnvelope(
  publicationId: string,
  state: SessionState,
): SessionStateEnvelope {
  return {
    version: 1,
    publicationId,
    status: 'pending',
    state: { ...state },
  };
}

function parseSessionStateEnvelope(serialized: string): SessionStateEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new Error('Session state envelope is not valid JSON', {
      cause: error,
    });
  }
  const envelope = requireRecord(value, 'Session state envelope');
  if (!Object.hasOwn(envelope, 'version')) {
    return pendingEnvelope(
      LEGACY_SESSION_STATE_PUBLICATION_ID,
      parseSessionState(envelope),
    );
  }
  const expectedKeys = envelope.status === 'consumed'
    ? ['version', 'publicationId', 'status', 'state', 'consumedAt']
    : ['version', 'publicationId', 'status', 'state'];
  assertExactKeys(envelope, expectedKeys, 'Session state envelope');
  if (
    envelope.version !== 1
    || (envelope.status !== 'pending' && envelope.status !== 'consumed')
  ) {
    throw new Error('Session state envelope version or status is invalid');
  }
  const publicationId = requireNonEmptyString(
    envelope.publicationId,
    'Session state publicationId',
  );
  const state = parseSessionState(envelope.state);
  if (envelope.status === 'pending') {
    return { version: 1, publicationId, status: 'pending', state };
  }
  return {
    version: 1,
    publicationId,
    status: 'consumed',
    state,
    consumedAt: requireIsoTimestamp(
      envelope.consumedAt,
      'Session state consumedAt',
    ),
  };
}

function parseSessionState(value: unknown): SessionState {
  const state = requireRecord(value, 'Session state');
  assertExactKeys(state, [
    'status',
    'taskResult',
    'errorMessage',
    'timestamp',
    'workflowName',
    'taskContent',
    'lastStep',
  ], 'Session state');
  if (
    state.status !== 'success'
    && state.status !== 'error'
    && state.status !== 'user_stopped'
  ) {
    throw new Error('Session state status is invalid');
  }
  const parsed: SessionState = {
    status: state.status,
    timestamp: requireIsoTimestamp(state.timestamp, 'Session state timestamp'),
    workflowName: requireNonEmptyString(
      state.workflowName,
      'Session state workflowName',
    ),
    ...optionalString(state, 'taskResult'),
    ...optionalString(state, 'errorMessage'),
    ...optionalString(state, 'taskContent'),
    ...optionalString(state, 'lastStep'),
  };
  return parsed;
}

function assertSessionState(state: SessionState): void {
  parseSessionState(state);
}

function compareSessionStateOrder(
  leftState: SessionState,
  leftPublicationId: string,
  rightState: SessionState,
  rightPublicationId: string,
): number {
  const timestampDifference =
    Date.parse(leftState.timestamp) - Date.parse(rightState.timestamp);
  return timestampDifference === 0
    ? leftPublicationId.localeCompare(rightPublicationId)
    : timestampDifference;
}

function sameSessionState(left: SessionState, right: SessionState): boolean {
  return left.status === right.status
    && left.taskResult === right.taskResult
    && left.errorMessage === right.errorMessage
    && left.timestamp === right.timestamp
    && left.workflowName === right.workflowName
    && left.taskContent === right.taskContent
    && left.lastStep === right.lastStep;
}

function requireSnapshotContent(
  snapshot: ReturnType<typeof readPrivateFileState>,
  path: string,
): Buffer {
  if (!('content' in snapshot)) {
    throw new Error(`Session state content is missing: ${path}`);
  }
  return snapshot.content;
}

function requireRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      throw new Error(`${label} contains unknown field "${key}"`);
    }
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireIsoTimestamp(value: unknown, label: string): string {
  const timestamp = requireNonEmptyString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${label} is invalid: ${timestamp}`);
  }
  return timestamp;
}

function optionalString<Key extends keyof SessionState>(
  value: Readonly<Record<string, unknown>>,
  key: Key,
): Partial<Pick<SessionState, Key>> {
  const field = value[key];
  if (field === undefined) {
    return {};
  }
  if (typeof field !== 'string') {
    throw new Error(`Session state ${key} must be a string`);
  }
  return { [key]: field } as Partial<Pick<SessionState, Key>>;
}

function assertPublicationId(publicationId: string): void {
  if (publicationId.length === 0) {
    throw new Error('Session state publicationId must be non-empty');
  }
}
