import { createHash } from 'node:crypto';
import type { RunStorageBackend } from '../../models/config-types.js';
import type { RunResumeSource } from './run-meta.js';

export interface BootstrapRecoverySeed {
  readonly version: 1;
  readonly task: string;
  readonly workflowName: string;
  readonly projectCwd: string;
  readonly backend: RunStorageBackend;
  readonly startedAt: string;
  readonly sessionId: string;
  readonly resumeSource: null | {
    readonly mode: RunResumeSource['resumeMode'];
    readonly sourceRunSlug: string | null;
  };
}

export function createBootstrapRecoverySeed(input: {
  readonly task: string;
  readonly workflowName: string;
  readonly projectCwd: string;
  readonly backend: RunStorageBackend;
  readonly startedAt: string;
  readonly sessionId: string;
  readonly resumeSource?: RunResumeSource;
}): BootstrapRecoverySeed {
  const seed: BootstrapRecoverySeed = {
    version: 1,
    task: input.task,
    workflowName: input.workflowName,
    projectCwd: input.projectCwd,
    backend: input.backend,
    startedAt: requireTimestamp(input.startedAt),
    sessionId: requireNonEmpty(input.sessionId, 'sessionId'),
    resumeSource: input.resumeSource === undefined
      ? null
      : {
          mode: input.resumeSource.resumeMode,
          sourceRunSlug: input.resumeSource.sourceRunSlug ?? null,
        },
  };
  return Object.freeze(seed);
}

export function parseBootstrapRecoverySeed(
  value: unknown,
): BootstrapRecoverySeed {
  const seed = requireRecord(value, 'Bootstrap recovery seed');
  assertExactKeys(seed, [
    'version',
    'task',
    'workflowName',
    'projectCwd',
    'backend',
    'startedAt',
    'sessionId',
    'resumeSource',
  ]);
  if (
    seed.version !== 1
    || (seed.backend !== 'file' && seed.backend !== 'sqlite')
  ) {
    throw new Error('Bootstrap recovery seed version or backend is invalid');
  }
  return Object.freeze({
    version: 1,
    task: requireString(seed.task, 'task'),
    workflowName: requireNonEmpty(seed.workflowName, 'workflowName'),
    projectCwd: requireNonEmpty(seed.projectCwd, 'projectCwd'),
    backend: seed.backend,
    startedAt: requireTimestamp(seed.startedAt),
    sessionId: requireNonEmpty(seed.sessionId, 'sessionId'),
    resumeSource: seed.resumeSource === null
      ? null
      : parseResumeSource(seed.resumeSource),
  });
}

export function serializeBootstrapRecoverySeed(
  seed: BootstrapRecoverySeed,
): string {
  return JSON.stringify(parseBootstrapRecoverySeed(seed));
}

export function bootstrapRecoverySeedSha256(
  seed: BootstrapRecoverySeed,
): string {
  return createHash('sha256')
    .update(serializeBootstrapRecoverySeed(seed))
    .digest('hex');
}

function parseResumeSource(
  value: unknown,
): NonNullable<BootstrapRecoverySeed['resumeSource']> {
  const source = requireRecord(value, 'Bootstrap recovery resume source');
  assertExactKeys(source, ['mode', 'sourceRunSlug']);
  if (
    source.mode !== 'requeue'
    && source.mode !== 'retry'
    && source.mode !== 'instruct'
  ) {
    throw new Error('Bootstrap recovery resume mode is invalid');
  }
  if (
    source.sourceRunSlug !== null
    && (
      typeof source.sourceRunSlug !== 'string'
      || source.sourceRunSlug.length === 0
    )
  ) {
    throw new Error('Bootstrap recovery source run slug is invalid');
  }
  return {
    mode: source.mode,
    sourceRunSlug: source.sourceRunSlug,
  };
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
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error('Bootstrap recovery seed fields are invalid');
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Bootstrap recovery seed ${label} must be a string`);
  }
  return value;
}

function requireNonEmpty(value: unknown, label: string): string {
  const string = requireString(value, label);
  if (string.length === 0) {
    throw new Error(`Bootstrap recovery seed ${label} must be non-empty`);
  }
  return string;
}

function requireTimestamp(value: unknown): string {
  const timestamp = requireNonEmpty(value, 'startedAt');
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error('Bootstrap recovery seed startedAt is invalid');
  }
  return timestamp;
}
