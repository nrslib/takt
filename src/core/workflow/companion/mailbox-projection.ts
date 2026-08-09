import { Buffer } from 'node:buffer';
import {
  existsSync,
  lstatSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, parse, resolve, sep } from 'node:path';
import {
  ensurePrivateDirectory,
  writePrivateFileWithModeGuarded,
} from '../../../shared/utils/private-file.js';
import {
  assertCompanionCapacity,
  COMPANION_CUMULATIVE_LIMITS,
} from './limits.js';

export function buildCompanionMailboxProjection(
  currentProjection: string,
  records: readonly object[],
): string {
  assertCompanionMailboxProjectionCapacity(currentProjection);
  const existingRecordCount = countProjectionRecords(currentProjection);
  assertCompanionCapacity(
    existingRecordCount + records.length <= COMPANION_CUMULATIVE_LIMITS.maxRecordsPerMailbox,
    'mailbox_records',
  );
  const projection = `${currentProjection}${records
    .map((record) => `${JSON.stringify(record)}\n`)
    .join('')}`;
  assertCompanionMailboxProjectionCapacity(projection);
  return projection;
}

export function appendCompanionMailboxRecords(
  path: string,
  currentProjection: string,
  records: readonly object[],
): string {
  const nextProjection = buildCompanionMailboxProjection(currentProjection, records);
  assertSafeMailboxPath(path);
  ensurePrivateDirectory(dirname(path));
  assertCurrentMailboxProjection(path, currentProjection);
  if (records.length > 0) {
    writePrivateFileWithModeGuarded(path, nextProjection, 0o600, () => {
      assertCurrentMailboxProjection(path, currentProjection);
      return true;
    });
  }
  return nextProjection;
}

export function readCompanionMailboxProjection(path: string): string {
  if (!existsSync(path)) return '';
  assertSafeMailboxPath(path);
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`Companion mailbox path is not a file: ${path}`);
  assertCompanionCapacity(
    stat.size <= COMPANION_CUMULATIVE_LIMITS.maxMailboxProjectionBytes,
    'mailbox_projection_bytes',
  );
  const projection = readFileSync(path, 'utf8');
  assertCompanionMailboxProjectionCapacity(projection);
  return projection;
}

function assertCurrentMailboxProjection(path: string, expectedProjection: string): void {
  const persistedProjection = readCompanionMailboxProjection(path);
  if (persistedProjection !== expectedProjection) {
    throw new Error(`Companion mailbox projection changed outside the engine: ${path}`);
  }
}

export function assertCompanionMailboxProjectionCapacity(projection: string): void {
  assertCompanionCapacity(
    Buffer.byteLength(projection, 'utf8')
      <= COMPANION_CUMULATIVE_LIMITS.maxMailboxProjectionBytes,
    'mailbox_projection_bytes',
  );
}

function countProjectionRecords(projection: string): number {
  if (projection.length === 0) return 0;
  return projection.split('\n').filter((line) => line.trim().length > 0).length;
}

function assertSafeMailboxPath(path: string): void {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(sep);
  let current = parsed.root;
  for (const segment of segments) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    if (!lstatSync(current).isSymbolicLink()) continue;
    throw new Error(`Companion mailbox path contains a symbolic link: ${current}`);
  }
}
