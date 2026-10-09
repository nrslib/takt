import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, unlinkSync, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensurePrivateDirectory, removePrivateDirectory, writeNewPrivateFileWithMode } from '../../shared/utils/private-file.js';
import { publishPrivateArtifact } from '../../shared/utils/private-artifact-backend.js';
import { assertAncestorIdentities, hasMatchingIdentity, inspectPrivateArtifactPath, lstatOrUndefined, type DirectoryIdentity } from '../../shared/utils/private-path-identity.js';
import { boundedRecords, jsonBytes, selectRecordPage, type RecordPageInfo } from '../../shared/utils/bounded-records.js';
import { createLogger } from '../../shared/utils/debug.js';
import { GoalDecisionSchema, GoalOperationSchema, type Goal } from './schema.js';
import { normalizeLegacyDecision } from './migration.js';

export type GoalRecordKind = 'decisions' | 'operations';
type GoalRecord = NonNullable<Goal[GoalRecordKind]>[number];
export type GoalRecordPage = RecordPageInfo & { records: GoalRecord[]; recordIndex?: number };

const HEADER_BYTES = 512;
const ENTRY_BYTES = 32;
const READY_FILE = 'ready.json';
const log = createLogger('goal-record-pages');
interface Entry { recordIndex: number; start: number; length: number; jsonBytes: number }
interface Header { identity: string; total: number; legacy: boolean }

function fileGeneration(stat: Stats): string {
  return `${stat.dev}-${stat.ino}-${stat.size}-${stat.mtimeMs}`;
}

function indexDirectory(filePath: string, stat: Stats): string {
  return join(dirname(filePath), `.records-${fileGeneration(stat)}`);
}

function indexName(kind: GoalRecordKind, eventId: string | undefined): string {
  return `${kind}.${eventId === undefined ? 'all' : createHash('sha256').update(eventId).digest('hex')}`;
}

function valueEnd(content: Buffer, start: number): number {
  let depth = 0;
  let quoted = false;
  for (let index = start; index < content.length; index += 1) {
    const byte = content[index];
    if (quoted) {
      if (byte === 92) index += 1;
      else if (byte === 34) { quoted = false; if (depth === 0) return index + 1; }
    } else if (byte === 34) quoted = true;
    else if (byte === 123 || byte === 91) depth += 1;
    else if (byte === 125 || byte === 93) { if (depth === 0) return index; if (--depth === 0) return index + 1; }
    else if (depth === 0 && (byte === 44 || byte === 10 || byte === 13 || byte === 32)) return index;
  }
  throw new Error('Incomplete saved goal value');
}

function skipSpace(content: Buffer, start: number): number {
  while ([9, 10, 13, 32].includes(content[start]!)) start += 1;
  return start;
}

// Only top-level arrays participate; operation arguments can contain identically named fields.
function recordSpans(content: Buffer): Record<GoalRecordKind, Array<{ start: number; length: number }>> {
  const spans: Record<GoalRecordKind, Array<{ start: number; length: number }>> = { decisions: [], operations: [] };
  let position = skipSpace(content, 0) + 1;
  while (content[position = skipSpace(content, position)] !== 125) {
    const keyEnd = valueEnd(content, position);
    const key: string = JSON.parse(content.subarray(position, keyEnd).toString('utf8'));
    position = skipSpace(content, keyEnd) + 1;
    const start = skipSpace(content, position);
    const end = valueEnd(content, start);
    if (key === 'decisions' || key === 'operations') {
      let recordStart = skipSpace(content, start + 1);
      while (content[recordStart] !== 93) {
        const recordEnd = valueEnd(content, recordStart);
        spans[key].push({ start: recordStart, length: recordEnd - recordStart });
        recordStart = skipSpace(content, recordEnd);
        if (content[recordStart] === 44) recordStart = skipSpace(content, recordStart + 1);
      }
    }
    position = skipSpace(content, end);
    if (content[position] === 44) position += 1;
  }
  return spans;
}

function encodeIndex(header: Header, entries: readonly Entry[]): Buffer {
  const bytes = Buffer.alloc(HEADER_BYTES + entries.length * ENTRY_BYTES);
  const text = JSON.stringify(header);
  if (Buffer.byteLength(text) >= HEADER_BYTES) throw new Error('Goal record index header exceeds its budget');
  bytes.write(text);
  entries.forEach((entry, index) => {
    [entry.recordIndex, entry.start, entry.length, entry.jsonBytes].forEach((value, field) => {
      bytes.writeBigUInt64LE(BigInt(value), HEADER_BYTES + index * ENTRY_BYTES + field * 8);
    });
  });
  return bytes;
}

function removeIndexDirectory(path: string): void {
  const inspection = inspectPrivateArtifactPath(path, 'directory');
  const parent = inspection.ancestorIdentities.at(-1)!;
  assertAncestorIdentities(inspection.ancestorIdentities);
  removePrivateDirectory(dirname(path), path, parent.stat, inspection.expectedStat!);
}

export function prepareGoalRecordIndex(filePath: string, stat: Stats, content: Buffer, goal: Goal): void {
  const path = indexDirectory(filePath, stat);
  ensurePrivateDirectory(path);
  let ready = false;
  try {
    const spans = recordSpans(content);
    const raw: Record<string, unknown> = JSON.parse(content.toString('utf8'));
    const legacy = !Object.hasOwn(raw, 'executionStatus') && !Object.hasOwn(raw, 'acceptanceCriteriaVersion') && !Object.hasOwn(raw, 'operations');
    for (const kind of ['decisions', 'operations'] as const) {
      const records = goal[kind] ?? [];
      if (spans[kind].length !== records.length) throw new Error('Goal record index does not match the saved array');
      const entries = records.map((record, recordIndex): Entry => ({ recordIndex, ...spans[kind][recordIndex]!, jsonBytes: jsonBytes(record) }));
      const events = new Map<string, Entry[]>();
      records.forEach((record, index) => {
        if (record.eventId === null) return;
        const group = events.get(record.eventId) ?? [];
        group.push(entries[index]!);
        events.set(record.eventId, group);
      });
      const write = (eventId: string | undefined, selected: readonly Entry[]): void => {
        writeNewPrivateFileWithMode(join(path, indexName(kind, eventId)), encodeIndex({ identity: fileGeneration(stat), total: selected.length, legacy }, selected), 0o600);
      };
      write(undefined, entries);
      for (const [eventId, selected] of events) write(eventId, selected);
    }
    writeNewPrivateFileWithMode(join(path, READY_FILE), JSON.stringify({ identity: fileGeneration(stat) }), 0o600);
    ready = true;
  } finally {
    if (!ready) removeIndexDirectory(path);
  }
}

export function writeGoalWithRecordIndex(filePath: string, goal: Goal): void {
  const inspection = inspectPrivateArtifactPath(filePath, 'file');
  const parent = inspection.ancestorIdentities.at(-1)!;
  const temporaryPath = join(dirname(filePath), `.goal-${process.pid}-${randomUUID()}.tmp`);
  const content = Buffer.from(`${JSON.stringify(goal, null, 2)}\n`);
  let temporaryStat: Stats | undefined;
  let published = false;
  try {
    writeNewPrivateFileWithMode(temporaryPath, content, 0o600);
    temporaryStat = lstatSync(temporaryPath);
    prepareGoalRecordIndex(filePath, temporaryStat, content, goal);
    assertAncestorIdentities(inspection.ancestorIdentities);
    publishPrivateArtifact(dirname(filePath), temporaryPath, filePath, parent.stat, temporaryStat, inspection.expectedStat, 0o600);
    published = true;
    if (inspection.expectedStat !== undefined) {
      const oldIndex = indexDirectory(filePath, inspection.expectedStat);
      try {
        if (lstatOrUndefined(oldIndex) !== undefined) removeIndexDirectory(oldIndex);
      } catch (error) {
        // The goal and its new index are already published; cleanup cannot undo that success.
        try { log.warn('Failed to remove old goal record index', { path: oldIndex, error: String(error) }); }
        catch { /* Diagnostic failures must also preserve the published result. */ }
      }
    }
  } finally {
    if (!published && temporaryStat !== undefined) {
      removeTemporaryGoal(temporaryPath, temporaryStat, inspection.ancestorIdentities);
      const index = indexDirectory(filePath, temporaryStat);
      if (lstatOrUndefined(index) !== undefined) removeIndexDirectory(index);
    }
  }
}

function removeTemporaryGoal(path: string, stat: Stats, ancestors: readonly DirectoryIdentity[]): void {
  const current = lstatOrUndefined(path);
  assertAncestorIdentities(ancestors);
  if (current === undefined) return;
  if (!hasMatchingIdentity(stat, current)) throw new Error('Goal temporary file identity changed before cleanup');
  unlinkSync(path);
}

function openRecordFile(path: string): { descriptor: number; assertUnchanged: () => void } {
  const inspection = inspectPrivateArtifactPath(path, 'file');
  if (inspection.expectedStat === undefined) throw new Error(`Goal record file does not exist: ${path}`);
  const expected = inspection.expectedStat;
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const assertUnchanged = (): void => {
    assertAncestorIdentities(inspection.ancestorIdentities);
    const current = lstatOrUndefined(path);
    if (current === undefined || fileGeneration(current) !== fileGeneration(expected)
      || fileGeneration(fstatSync(descriptor)) !== fileGeneration(expected)) throw new Error(`Goal record file changed during reading: ${path}`);
  };
  try { assertUnchanged(); }
  catch (error) { closeSync(descriptor); throw error; }
  return { descriptor, assertUnchanged };
}

function readRange(descriptor: number, start: number, length: number): Buffer {
  const content = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = readSync(descriptor, content, read, length - read, start + read);
    if (count === 0) throw new Error('Goal record range is incomplete');
    read += count;
  }
  return content;
}

export function readGoalRecordPage(
  filePath: string, goalId: string, kind: GoalRecordKind, eventId: string | undefined,
  offset: number, limit: number, budget: number,
): GoalRecordPage | undefined {
  const goalFile = openRecordFile(filePath);
  let indexFile: ReturnType<typeof openRecordFile> | undefined;
  try {
    const identity = fileGeneration(fstatSync(goalFile.descriptor));
    const directory = indexDirectory(filePath, fstatSync(goalFile.descriptor));
    const readyPath = join(directory, READY_FILE);
    if (lstatOrUndefined(readyPath) === undefined) return undefined;
    const readyFile = openRecordFile(readyPath);
    try {
      const ready: { identity: string } = JSON.parse(readRange(readyFile.descriptor, 0, fstatSync(readyFile.descriptor).size).toString('utf8'));
      if (ready.identity !== identity) throw new Error('Goal record index belongs to another file generation');
      readyFile.assertUnchanged();
    } finally { closeSync(readyFile.descriptor); }
    const indexPath = join(directory, indexName(kind, eventId));
    if (lstatOrUndefined(indexPath) === undefined && eventId !== undefined) {
      goalFile.assertUnchanged();
      return boundedRecords<GoalRecord>([], offset, limit, budget);
    }
    indexFile = openRecordFile(indexPath);
    const header: Header = JSON.parse(readRange(indexFile.descriptor, 0, HEADER_BYTES).toString('utf8').replace(/\0+$/, ''));
    if (header.identity !== identity || !Number.isSafeInteger(header.total) || header.total < 0) throw new Error('Invalid goal record index header');
    const entries = new Map<number, Entry>();
    const { endOffset, ...info } = selectRecordPage(header.total, offset, limit, budget, (index) => {
      const bytes = readRange(indexFile!.descriptor, HEADER_BYTES + index * ENTRY_BYTES, ENTRY_BYTES);
      const values = [0, 8, 16, 24].map((field) => Number(bytes.readBigUInt64LE(field)));
      if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid goal record index entry');
      const entry = { recordIndex: values[0]!, start: values[1]!, length: values[2]!, jsonBytes: values[3]! };
      entries.set(index, entry);
      return entry.jsonBytes;
    });
    const records: GoalRecord[] = [];
    for (let index = offset; index < endOffset; index += 1) {
      const entry = entries.get(index)!;
      const raw: unknown = JSON.parse(readRange(goalFile.descriptor, entry.start, entry.length).toString('utf8'));
      records.push(kind === 'operations' ? GoalOperationSchema.parse(raw)
        : header.legacy ? normalizeLegacyDecision(goalId, raw, entry.recordIndex) : GoalDecisionSchema.parse(raw));
    }
    indexFile.assertUnchanged();
    goalFile.assertUnchanged();
    return { records, ...info, ...(info.oversized ? { recordIndex: entries.get(offset)!.recordIndex } : {}) };
  } finally {
    if (indexFile !== undefined) closeSync(indexFile.descriptor);
    closeSync(goalFile.descriptor);
  }
}
