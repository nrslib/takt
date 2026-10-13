import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalRecordReadConflictError, writeGoalWithRecordIndex } from '../infra/goals/record-pages.js';
import { GoalStore } from '../infra/goals/store.js';
import { goalId, legacyGoalRecord } from './helpers/goal-fixtures.js';
import { reconcileGoalTasks } from '../infra/goals/reconcile.js';
import { TaskRunner } from '../infra/task/runner.js';
import { listTaktGoalRecords } from '../features/mcp/goalDecisionOperations.js';
import { buildGoalTurnContext } from '../features/manager/turnContext.js';
import * as privateFiles from '../shared/utils/private-file.js';
import * as artifacts from '../shared/utils/private-artifact-backend.js';
import * as identities from '../shared/utils/private-path-identity.js';
import { DebugLogger } from '../shared/utils/debug.js';
import { firstTextContent } from './helpers/mcp-content.js';
import type { Goal, GoalEvent } from '../infra/goals/schema.js';

vi.mock('../shared/utils/private-file.js', async (original) => ({ ...await original<typeof import('../shared/utils/private-file.js')>() }));
vi.mock('../shared/utils/private-artifact-backend.js', async (original) => ({ ...await original<typeof import('../shared/utils/private-artifact-backend.js')>() }));
vi.mock('../shared/utils/private-path-identity.js', async (original) => ({ ...await original<typeof import('../shared/utils/private-path-identity.js')>() }));

const reads = vi.hoisted(() => ({ whole: vi.fn(), range: vi.fn(), open: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  reads.whole.mockImplementation(actual.readFileSync);
  reads.range.mockImplementation(actual.readSync);
  reads.open.mockImplementation(actual.openSync);
  return { ...actual, readFileSync: reads.whole, readSync: reads.range, openSync: reads.open };
});

function goalRecord() {
  return { ...legacyGoalRecord(), executionStatus: 'active' as const, acceptanceCriteriaVersion: 1 };
}

describe('GoalStore persistence', () => {
  let cwd: string;
  let goalPath: string;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    reads.whole.mockImplementation(actual.readFileSync);
    reads.range.mockImplementation(actual.readSync);
    reads.open.mockImplementation(actual.openSync);
    cwd = mkdtempSync(join(tmpdir(), 'takt-goal-store-'));
    goalPath = join(cwd, '.takt', 'goals', goalId, 'goal.json');
  });

  afterEach(() => { vi.restoreAllMocks(); rmSync(cwd, { recursive: true, force: true }); });

  it.each(['decisions', 'operations'] as const)('measures %s read work while only history outside the requested page grows', async (kind) => {
    const samples = [];
    for (const count of [100, 1000]) {
      const decisions = Array.from({ length: count }, (_, index) => ({
        id: `decision-${index}`, eventId: 'event-a', actor: null, operation: 'notify', reason: '日本語"\n',
        evidenceRefs: [], acceptanceCriteriaVersion: 1, recordedAt: '2026-10-08T00:00:00Z',
      }));
      const operations = decisions.map(({ id, eventId, recordedAt }) => ({
        id, eventId, recordedAt, operationName: id, tool: 'notify' as const, arguments: { body: '日本語"\n' }, status: 'pending' as const,
      }));
      const records = kind === 'decisions' ? { decisions } : { operations };
      const store = new GoalStore(cwd);
      if (count === 100) await store.create({ ...goalRecord(), ...records });
      else await store.update(goalId, (goal) => ({ ...goal, ...records }));
      reads.whole.mockClear();
      reads.range.mockClear();
      const parse = vi.spyOn(JSON, 'parse');
      const result = await listTaktGoalRecords({ cwd, goalId, eventId: 'event-a', offset: 0, limit: 1 }, {}, kind);
      const parsed = parse.mock.results.map(({ value }) => value);
      parse.mockRestore();
      expect(result.isError).toBeUndefined();
      const bytes = reads.whole.mock.results.reduce((sum, { value }) => sum + Buffer.byteLength(value as Buffer), 0)
        + reads.range.mock.results.reduce((sum, { value }) => sum + (value as number), 0);
      const decoded = parsed.reduce((sum, value: { decisions?: unknown[]; operations?: unknown[]; id?: string }) => sum + (value.decisions?.length ?? value.operations?.length ?? (value.id === undefined ? 0 : 1)), 0);
      samples.push({ count, bytes, decoded, entries: reads.range.mock.calls.filter((args) => args[3] === 32).length });
    }
    process.stdout.write(`Goal ${kind} read measurement: ${JSON.stringify(samples)}\n`);
    expect(Math.abs(samples[1]!.bytes - samples[0]!.bytes)).toBeLessThanOrEqual(16);
    expect(samples.map(({ decoded, entries }) => ({ decoded, entries }))).toEqual([{ decoded: 1, entries: 1 }, { decoded: 1, entries: 1 }]);
  });

  function decision(id: string, eventId: string | null = null): NonNullable<Goal['decisions']>[number] {
    return { id, eventId, actor: null, operation: 'notify', reason: '日本語"\n', evidenceRefs: [],
      acceptanceCriteriaVersion: 1, recordedAt: '2026-10-08T00:00:00Z' };
  }

  it.each(['decisions', 'operations'] as const)('only writes the changed event index on a single %s append', async (kind) => {
    const decisions = [decision('d0', 'event-a'), decision('d1', 'event-b')];
    const operations = decisions.map(({ id, eventId, recordedAt }) => ({ id, eventId: eventId!, recordedAt,
      operationName: id, tool: 'notify' as const, arguments: {}, status: 'completed' as const, result: { notificationId: id } }));
    const store = new GoalStore(cwd);
    await store.create({ ...goalRecord(), decisions, operations });
    const directory = join(cwd, '.takt', 'goals', goalId);
    const oldDirectory = join(directory, readdirSync(directory).find((name) => name.startsWith('.records-'))!);
    const unchangedNames = readdirSync(oldDirectory).filter((name) => name !== 'ready.json' && !name.endsWith('.all'));
    const before = new Map(unchangedNames.map((name) => [name, { stat: lstatSync(join(oldDirectory, name)), bytes: readFileSync(join(oldDirectory, name)) }]));
    const write = vi.spyOn(privateFiles, 'writeNewPrivateFileWithMode');
    const updated = await store.update(goalId, (goal) => ({ ...goal,
      [kind]: [...goal[kind]!, kind === 'decisions' ? decision('d2', 'event-b') : { ...operations[1]!, id: 'op2', operationName: 'notify:op2' }],
    }));
    const newDirectory = join(directory, readdirSync(directory).find((name) => name.startsWith('.records-'))!);
    const changedName = `${kind}.${createHash('sha256').update('event-b').digest('hex')}`;
    expect(write.mock.calls.map(([path]) => path).filter((path) => path.startsWith(newDirectory) && !path.endsWith('.all') && !path.endsWith('ready.json')))
      .toEqual([join(newDirectory, changedName)]);
    for (const [name, original] of before) {
      const path = join(newDirectory, name);
      if (name === changedName) {
        expect(lstatSync(path).ino).not.toBe(original.stat.ino);
      } else {
        expect(lstatSync(path)).toMatchObject({ ino: original.stat.ino, mtimeMs: original.stat.mtimeMs });
        expect(readFileSync(path)).toEqual(original.bytes);
      }
    }
    expect(existsSync(oldDirectory)).toBe(false);
    for (const recordKind of ['decisions', 'operations'] as const) {
      for (const eventId of ['event-a', 'event-b']) {
        const expected = updated[recordKind]!.filter((record) => record.eventId === eventId);
        expect(await new GoalStore(cwd).readRecordPage(goalId, recordKind, eventId, 0, 50, 48 * 1024))
          .toMatchObject({ records: expected, total: expected.length, nextOffset: null });
      }
    }
  });

  it('reuses event membership while reading updated results and shifted byte offsets from the current goal', async () => {
    const operation = { id: 'op0', eventId: 'event-a', operationName: 'notify:progress', tool: 'notify' as const,
      arguments: {}, status: 'pending' as const, recordedAt: '2026-10-08T00:00:00Z' };
    const store = new GoalStore(cwd);
    await store.create({ ...goalRecord(), decisions: [decision('d0', 'event-b')], operations: [operation] });
    const write = vi.spyOn(privateFiles, 'writeNewPrivateFileWithMode');
    const updated = await store.update(goalId, (goal) => ({ ...goal, objective: '日本語'.repeat(1000),
      decisions: [...goal.decisions!, decision('d1', 'event-b')],
      operations: [{ ...operation, status: 'completed', result: { notificationId: 'saved', body: 'changed'.repeat(1000) } }],
    }));
    const eventName = `operations.${createHash('sha256').update('event-a').digest('hex')}`;
    expect(write.mock.calls.filter(([path]) => path.endsWith(eventName))).toEqual([]);
    expect(await new GoalStore(cwd).readRecordPage(goalId, 'operations', 'event-a', 0, 1, 48 * 1024))
      .toMatchObject({ records: updated.operations, total: 1, nextOffset: null });
    expect(await new GoalStore(cwd).readRecordPage(goalId, 'operations', 'event-a', 0, 1, 100))
      .toMatchObject({ records: [], oversized: true, recordIndex: 0 });
  });

  it('reads the actual continuation advertised by a turn containing current and prior operations', async () => {
    const event: GoalEvent = { id: 'event-a', kind: 'completion', taskName: 'task-a', runSlug: 'run-a',
      result: { success: true, interrupted: false }, processed: false };
    const prior = { id: 'prior', eventId: 'event-b', operationName: 'notify:prior', tool: 'notify' as const,
      arguments: {}, status: 'pending' as const, recordedAt: '2026-10-08T00:00:00Z' };
    const current = Array.from({ length: 1000 }, (_, index) => ({ ...prior, id: `current-${index}`,
      eventId: event.id, operationName: `notify:current-${index}`, status: 'completed' as const,
      result: { notificationId: `notification-${index}` } }));
    const goal = await new GoalStore(cwd).create({ ...goalRecord(), events: [event], operations: [prior, ...current] });
    const context = JSON.parse(buildGoalTurnContext(cwd, goal, event, []));
    const continuation = context.omissions.operations.currentEvent;
    expect(continuation).toMatchObject({ tool: 'takt_list_goal_operations', nextOffset: context.goal.operations.length,
      arguments: { cwd, goalId, eventId: event.id, offset: context.goal.operations.length, limit: 20 } });
    const result = await listTaktGoalRecords(continuation.arguments,
      { goalEventContext: { goalId, eventId: 'event-b' } }, 'operations');
    expect(result.isError).toBeUndefined();
    const page = JSON.parse(firstTextContent(result.content));
    expect(page.operations).toEqual(current.slice(continuation.nextOffset, continuation.nextOffset + 20));
    expect(page).toMatchObject({ total: 1000, nextOffset: continuation.nextOffset + 20 });
    const previous = context.omissions.operations.prior;
    expect(previous).toMatchObject({ total: 1, omitted: 1, source: goalPath, field: 'operations', recordIndex: 0 });
    expect(JSON.parse(readFileSync(previous.source, 'utf8'))[previous.field][previous.recordIndex]).toEqual(prior);
  });

  it('keeps saved order, exact counts and continuation positions for decision pages', async () => {
    const decisions = [decision('d0'), decision('d1', 'event-a'), decision('d2', 'event-a')];
    await new GoalStore(cwd).create({ ...goalRecord(), decisions });
    const store = new GoalStore(cwd);
    expect(await store.readRecordPage(goalId, 'decisions', undefined, 1, 1, 48 * 1024)).toMatchObject({
      records: [decisions[1]], total: 3, nextOffset: 2, omitted: 2, oversized: false,
    });
    expect(await store.readRecordPage(goalId, 'decisions', undefined, 2, 50, 48 * 1024)).toMatchObject({ records: [decisions[2]], nextOffset: null });
    expect(await store.readRecordPage(goalId, 'decisions', undefined, 3, 1, 48 * 1024)).toMatchObject({ records: [], total: 3, nextOffset: null });
    expect(await store.readRecordPage(goalId, 'decisions', undefined, 10, 1, 48 * 1024)).toMatchObject({ records: [], total: 3, omitted: 3, nextOffset: null });
    expect(await store.readRecordPage(goalId, 'decisions', 'event-a', 0, 2, 48 * 1024)).toMatchObject({ records: decisions.slice(1), total: 2, nextOffset: null });
  });

  it('indexes only top-level operations and returns the original array position without reading an oversized body', async () => {
    const operation = { id: 'op0', eventId: 'event-other', operationName: 'notify:other', tool: 'notify' as const,
      arguments: {}, status: 'pending' as const, recordedAt: '2026-10-08T00:00:00Z' };
    const nested = { ...operation, id: 'op1', eventId: 'event-a', arguments: { operations: [{ eventId: 'event-b' }] } };
    const huge = { ...operation, id: 'op2', eventId: 'event-a', arguments: { body: '日本語'.repeat(10000) } };
    await new GoalStore(cwd).create({ ...goalRecord(), operations: [operation, nested] });
    const store = new GoalStore(cwd);
    expect(await store.readRecordPage(goalId, 'operations', 'event-b', 0, 1, 48 * 1024)).toMatchObject({ records: [], total: 0 });
    expect(await store.readRecordPage(goalId, 'operations', 'event-a', 0, 1, 48 * 1024)).toMatchObject({ records: [nested], total: 1, nextOffset: null });
    await store.update(goalId, (goal) => ({ ...goal, operations: [operation, nested, huge] }));
    reads.range.mockClear();
    reads.whole.mockClear();
    const page = await listTaktGoalRecords({ cwd, goalId, eventId: 'event-a', offset: 1, limit: 1 }, {}, 'operations');
    expect(JSON.parse(firstTextContent(page.content))).toMatchObject({ operations: [], total: 2,
      recordIndex: 2, oversized: true, nextOffset: 1, source: goalPath });
    expect(reads.whole).not.toHaveBeenCalled();
    expect(reads.range.mock.results.reduce((sum, { value }) => sum + (value as number), 0)).toBeLessThan(1024);
  });

  it.each(['decisions', 'operations'] as const)('restarts %s pages from the new generation when files disappear during reading', async (kind) => {
    const operation = (id: string) => ({ id, eventId: 'event-a', operationName: `notify:${id}`, tool: 'notify' as const,
      arguments: {}, status: 'pending' as const, recordedAt: '2026-10-08T00:00:00Z' });
    const old = { ...goalRecord(), decisions: [decision('old')], operations: [operation('old')] };
    const updated = { ...old, decisions: [decision('new')], operations: [operation('new')] };
    const store = new GoalStore(cwd);
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    for (const point of ['ready open', 'index open', 'page read'] as const) {
      if (!existsSync(goalPath)) await store.create(old);
      else await store.update(goalId, () => old);
      let updatedDuringRead = false;
      reads.open.mockImplementation((...args: Parameters<typeof actual.openSync>) => {
        const path = String(args[0]);
        if (!updatedDuringRead && (point === 'ready open' ? path.endsWith('ready.json') : point === 'index open' && path.endsWith(`${kind}.all`))) {
          updatedDuringRead = true;
          writeGoalWithRecordIndex(goalPath, updated);
        }
        return actual.openSync(...args);
      });
      reads.range.mockImplementation((descriptor: number, buffer: Buffer, offset: number, length: number, position: number) => {
        const count = actual.readSync(descriptor, buffer, offset, length, position);
        if (!updatedDuringRead && point === 'page read' && length !== 32 && position > 0) {
          updatedDuringRead = true;
          writeGoalWithRecordIndex(goalPath, updated);
        }
        return count;
      });
      reads.whole.mockClear();
      const page = await store.readRecordPage(goalId, kind, undefined, 0, 1, 48 * 1024);
      expect(updatedDuringRead).toBe(true);
      expect(page).toMatchObject({ records: updated[kind], total: 1, nextOffset: null, oversized: false });
      expect(reads.whole).not.toHaveBeenCalled();
      expect((await store.get(goalId))[kind]).toEqual(updated[kind]);
      reads.open.mockImplementation(actual.openSync);
      reads.range.mockImplementation(actual.readSync);
    }
  });

  it('stops after three page reads if every read races with publication', async () => {
    const store = new GoalStore(cwd);
    const original = { ...goalRecord(), decisions: [decision('old')] };
    await store.create(original);
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    let publications = 0;
    reads.open.mockImplementation((...args: Parameters<typeof actual.openSync>) => {
      if (String(args[0]).endsWith('decisions.all')) {
        publications += 1;
        writeGoalWithRecordIndex(goalPath, { ...original, decisions: [decision(`new-${publications}`)] });
      }
      return actual.openSync(...args);
    });
    await expect(store.readRecordPage(goalId, 'decisions', undefined, 0, 1, 48 * 1024)).rejects.toBeInstanceOf(GoalRecordReadConflictError);
    expect(publications).toBe(3);
  });

  it('does not retry a missing index when the saved goal generation has not changed', async () => {
    const store = new GoalStore(cwd);
    await store.create({ ...goalRecord(), decisions: [decision('saved')] });
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    let attempts = 0;
    reads.open.mockImplementation((...args: Parameters<typeof actual.openSync>) => {
      if (String(args[0]).endsWith('decisions.all')) {
        attempts += 1;
        throw Object.assign(new Error('Missing index'), { code: 'ENOENT' });
      }
      return actual.openSync(...args);
    });
    await expect(store.readRecordPage(goalId, 'decisions', undefined, 0, 1, 48 * 1024)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(attempts).toBe(1);
  });

  it('rejects a mismatched index generation instead of returning its records', async () => {
    await new GoalStore(cwd).create({ ...goalRecord(), decisions: [decision('decision-a')] });
    const folder = readdirSync(join(cwd, '.takt', 'goals', goalId)).find((name) => name.startsWith('.records-'))!;
    const indexPath = join(cwd, '.takt', 'goals', goalId, folder, 'decisions.all');
    const content = readFileSync(indexPath);
    const header = JSON.parse(content.subarray(0, 512).toString('utf8').replace(/\0+$/, ''));
    const store = new GoalStore(cwd);
    expect(await store.readRecordPage(goalId, 'decisions', undefined, 0, 1, 48 * 1024)).toMatchObject({ records: [decision('decision-a')] });
    content.fill(0, 0, 512);
    content.write(JSON.stringify({ ...header, identity: 'another-generation' }));
    writeFileSync(indexPath, content);
    await expect(store.readRecordPage(goalId, 'decisions', undefined, 0, 1, 48 * 1024)).rejects.toThrow();
  });

  it.each(['index preparation', 'goal publication'] as const)('keeps the old goal and its index when %s fails', async (failure) => {
    const store = new GoalStore(cwd);
    await store.create({ ...goalRecord(), decisions: [decision('old')] });
    const saved = readFileSync(goalPath);
    const directory = join(cwd, '.takt', 'goals', goalId);
    const files = readdirSync(directory).sort();
    if (failure === 'index preparation') {
      const write = privateFiles.writeNewPrivateFileWithMode;
      vi.spyOn(privateFiles, 'writeNewPrivateFileWithMode').mockImplementation((path, content, mode) => {
        if (path.endsWith('decisions.all')) throw new Error('Injected index preparation failure');
        return write(path, content, mode);
      });
    } else {
      const publish = artifacts.publishPrivateArtifact;
      vi.spyOn(artifacts, 'publishPrivateArtifact').mockImplementation((...args) => {
        if (args[2] === goalPath) throw new Error('Injected goal publication failure');
        return publish(...args);
      });
    }
    await expect(store.update(goalId, (goal) => ({ ...goal, decisions: [decision('new')] }))).rejects.toThrow();
    expect(readFileSync(goalPath)).toEqual(saved);
    expect(readdirSync(directory).sort()).toEqual(files);
    expect(await new GoalStore(cwd).readRecordPage(goalId, 'decisions', undefined, 0, 1, 48 * 1024)).toMatchObject({ records: [decision('old')] });
  });

  it.each([false, true])('returns the published goal when old index removal fails=%s', async (fails) => {
    const store = new GoalStore(cwd);
    await store.create({ ...goalRecord(), decisions: [decision('old')] });
    const directory = join(cwd, '.takt', 'goals', goalId);
    const oldIndex = join(directory, readdirSync(directory).find((name) => name.startsWith('.records-'))!);
    const remove = privateFiles.removePrivateDirectory;
    const warning = vi.spyOn(DebugLogger.getInstance(), 'writeLog');
    const cleanup = vi.spyOn(privateFiles, 'removePrivateDirectory').mockImplementation((...args) => {
      if (args[1] === oldIndex && fails) throw new Error('Injected old index removal failure');
      return remove(...args);
    });
    const [result] = await Promise.allSettled([store.update(goalId, (goal) => ({ ...goal, decisions: [decision('new')] }))]);
    expect(cleanup.mock.calls.filter((args) => args[1] === oldIndex)).toHaveLength(1);
    const independent = new GoalStore(cwd);
    expect((await independent.get(goalId)).decisions).toEqual([decision('new')]);
    reads.whole.mockClear();
    expect(await independent.readRecordPage(goalId, 'decisions', undefined, 0, 1, 48 * 1024)).toMatchObject({ records: [decision('new')] });
    expect(reads.whole).not.toHaveBeenCalled();
    expect(existsSync(oldIndex)).toBe(fails);
    expect(warning.mock.calls.filter(([level, component]) => level === 'WARN' && component === 'goal-record-pages')).toHaveLength(fails ? 1 : 0);
    if (fails) expect(warning.mock.calls[0]![3]).toEqual({ path: oldIndex, error: expect.any(String) });
    expect(result!.status).toBe('fulfilled');
    if (result!.status === 'fulfilled') expect(result!.value.decisions).toEqual([decision('new')]);
  });

  it.each(['existence check', 'safety inspection', 'diagnostic'] as const)('preserves publication when old index %s fails', async (failure) => {
    const store = new GoalStore(cwd);
    await store.create({ ...goalRecord(), decisions: [decision('old')] });
    const directory = join(cwd, '.takt', 'goals', goalId);
    const oldIndex = join(directory, readdirSync(directory).find((name) => name.startsWith('.records-'))!);
    const actualRemove = privateFiles.removePrivateDirectory;
    const remove = vi.spyOn(privateFiles, 'removePrivateDirectory');
    const warning = vi.spyOn(DebugLogger.getInstance(), 'writeLog');
    let injected = false;
    if (failure === 'existence check') {
      const lstat = identities.lstatOrUndefined;
      vi.spyOn(identities, 'lstatOrUndefined').mockImplementation((path) => {
        if (path === oldIndex) { injected = true; throw new Error('Injected old index existence failure'); }
        return lstat(path);
      });
    } else if (failure === 'safety inspection') {
      const inspect = identities.inspectPrivateArtifactPath;
      vi.spyOn(identities, 'inspectPrivateArtifactPath').mockImplementation((...args) => {
        if (args[0] === oldIndex) { injected = true; throw new Error('Injected old index inspection failure'); }
        return inspect(...args);
      });
    } else {
      remove.mockImplementation((...args) => {
        if (args[1] === oldIndex) throw new Error('Injected old index removal failure');
        return actualRemove(...args);
      });
      warning.mockImplementation(() => { injected = true; throw new Error('Injected diagnostic failure'); });
    }
    const result = await store.update(goalId, (goal) => ({ ...goal, decisions: [decision('new')] }));
    expect(injected).toBe(true);
    expect(result.decisions).toEqual([decision('new')]);
    expect((await new GoalStore(cwd).get(goalId)).decisions).toEqual(result.decisions);
    expect(await new GoalStore(cwd).readRecordPage(goalId, 'decisions', undefined, 0, 1, 48 * 1024)).toMatchObject({ records: result.decisions });
    if (failure !== 'diagnostic') expect(remove).not.toHaveBeenCalled();
    expect(existsSync(oldIndex)).toBe(true);
    expect(warning).toHaveBeenCalled();
  });

  it('prepares a legacy index once without changing goal bytes, then reads and updates stable decisions', async () => {
    saveLegacyGoal(false);
    const bytes = readFileSync(goalPath);
    const original = await new GoalStore(cwd).get(goalId);
    expect(await new GoalStore(cwd).readRecordPage(goalId, 'decisions', undefined, 0, 1, 48 * 1024)).toMatchObject({ records: original.decisions });
    expect(readFileSync(goalPath)).toEqual(bytes);
    reads.whole.mockClear();
    expect(await new GoalStore(cwd).readRecordPage(goalId, 'decisions', undefined, 0, 1, 48 * 1024)).toMatchObject({ records: original.decisions });
    expect(reads.whole).not.toHaveBeenCalled();
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, objective: 'updated' }));
    expect(await new GoalStore(cwd).readRecordPage(goalId, 'decisions', undefined, 0, 1, 48 * 1024)).toMatchObject({ records: original.decisions });
  });

  it('preserves unindexed data when index preparation fails and rejects invalid new-format pages', async () => {
    saveLegacyGoal(false);
    const saved = readFileSync(goalPath);
    const write = privateFiles.writeNewPrivateFileWithMode;
    const failure = vi.spyOn(privateFiles, 'writeNewPrivateFileWithMode').mockImplementation((path, content, mode) => {
      if (path.endsWith('decisions.all')) throw new Error('Injected index preparation failure');
      return write(path, content, mode);
    });
    await expect(new GoalStore(cwd).readRecordPage(goalId, 'decisions', undefined, 0, 1, 48 * 1024)).rejects.toThrow();
    expect(readFileSync(goalPath)).toEqual(saved);
    failure.mockRestore();
    await expect(new GoalStore(cwd).readRecordPage(goalId, 'decisions', undefined, 0, 1, 48 * 1024)).resolves.toMatchObject({ total: 1 });
    writeFileSync(goalPath, JSON.stringify({ ...goalRecord(), executionStatus: 'unknown' }));
    await expect(new GoalStore(cwd).readRecordPage(goalId, 'decisions', undefined, 0, 1, 48 * 1024)).rejects.toThrow();
  });

  function saveLegacyGoal(processed: boolean) {
    const completion = { taskName: 'task-a', runSlug: 'run-a', result: { success: true, interrupted: false }, processed, summary: 'saved summary' };
    const answer = { text: 'JSON', source: 'tui', answeredAt: '2026-10-08T00:00:00Z' };
    const record = { ...legacyGoalRecord(), events: [completion],
      answerEvents: [{ questionId: '650e8400-e29b-41d4-a716-446655440001', answer, processed: false }],
      sessions: [{ provider: 'mock', sessionId: 'old-session' }],
      decisions: [{ decision: 'integrate', reason: 'legacy reason', recordedAt: '2026-10-08T00:00:00Z' }],
    };
    mkdirSync(join(cwd, '.takt', 'goals', goalId), { recursive: true });
    writeFileSync(goalPath, JSON.stringify(record));
    return record;
  }

  it('reads legacy events with stable IDs from independent stores without changing saved bytes', async () => {
    saveLegacyGoal(false);
    const bytes = readFileSync(goalPath);
    const first = await new GoalStore(cwd).get(goalId);
    const second = await new GoalStore(cwd).get(goalId);
    expect(first).toMatchObject({ executionStatus: 'active', acceptanceCriteriaVersion: 1 });
    expect(first.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.any(String), kind: 'completion', taskName: 'task-a', runSlug: 'run-a' }),
      expect.objectContaining({ id: expect.any(String), kind: 'answer', questionId: '650e8400-e29b-41d4-a716-446655440001' }),
    ]));
    expect(second.events).toEqual(first.events);
    expect((await new GoalStore(cwd).list()).goals).toEqual([first]);
    expect(readFileSync(goalPath)).toEqual(bytes);
  });

  it('preserves a migrated processed event and summary when the queue supplies the same result', async () => {
    const legacy = saveLegacyGoal(true);
    vi.spyOn(TaskRunner.prototype, 'listTaskStateItems').mockReturnValue([{
      name: 'task-a', kind: 'completed', status: 'completed', createdAt: '2026-10-08T00:00:00Z',
      filePath: join(cwd, '.takt', 'tasks.yaml'), goalId, runSlug: 'run-a', completion: legacy.events[0]!.result,
    }]);
    const before = await new GoalStore(cwd).get(goalId);
    await reconcileGoalTasks(cwd, goalId);
    const after = await new GoalStore(cwd).get(goalId);
    expect(after.events).toEqual(before.events);
    expect(after.events).toContainEqual(expect.objectContaining({
      id: expect.any(String), kind: 'completion', processed: true, summary: 'saved summary',
    }));
  });

  it('writes only the new format on update and migrates old decisions once', async () => {
    saveLegacyGoal(false);
    const store = new GoalStore(cwd);
    const migrated = await store.get(goalId);
    await store.update(goalId, (goal) => ({ ...goal, objective: 'updated purpose' }));
    const saved = JSON.parse(readFileSync(goalPath, 'utf8'));
    expect(saved).toMatchObject({ objective: 'updated purpose', executionStatus: 'active', acceptanceCriteriaVersion: 1,
      events: migrated.events, decisions: [expect.objectContaining({ reason: 'legacy reason' })] });
    expect(saved).not.toHaveProperty('sessions');
    expect(saved).not.toHaveProperty('answerEvents');
    await store.update(goalId, (goal) => goal);
    expect((await new GoalStore(cwd).get(goalId)).decisions).toEqual(saved.decisions);
  });

  it('rejects invalid new-format state rather than treating it as a legacy goal', async () => {
    mkdirSync(join(cwd, '.takt', 'goals', goalId), { recursive: true });
    writeFileSync(goalPath, JSON.stringify({ ...goalRecord(), executionStatus: 'unknown' }));
    await expect(new GoalStore(cwd).get(goalId)).rejects.toThrow();
  });

  it.each(['human', 'director'] as const)('roundtrips all required saved values for %s creation', async (creationOrigin) => {
    const record = { ...goalRecord(), creationOrigin };
    await new GoalStore(cwd).create(record);
    expect(JSON.parse(readFileSync(goalPath, 'utf-8'))).toEqual(record);
    expect(await new GoalStore(cwd).get(goalId)).toEqual(record);
    expect(await new GoalStore(cwd).list()).toEqual({ goals: [record], errors: [] });
  });

  it('returns an empty list without creating the absent goals directory', async () => {
    expect(await new GoalStore(cwd).list()).toEqual({ goals: [], errors: [] });
    expect(existsSync(join(cwd, '.takt', 'goals'))).toBe(false);
  });

  it('rejects a missing goal instead of returning an unrelated record', async () => {
    await new GoalStore(cwd).create(goalRecord());
    await expect(new GoalStore(cwd).get('550e8400-e29b-41d4-a716-446655440001')).rejects.toThrow();
  });

  it('rejects duplicate registration without replacing saved bytes', async () => {
    await new GoalStore(cwd).create(goalRecord());
    const before = readFileSync(goalPath);
    await expect(new GoalStore(cwd).create({ ...goalRecord(), objective: 'replacement' })).rejects.toThrow();
    expect(readFileSync(goalPath)).toEqual(before);
  });

  it('keeps an already registered goal readable during concurrent registration attempts', async () => {
    const record = goalRecord();
    await new GoalStore(cwd).create(record);
    const before = readFileSync(goalPath);
    const candidates = [record, { ...record, objective: 'replacement one' }, { ...record, objective: 'replacement two' }];
    const results = await Promise.allSettled(candidates.map((candidate) => new GoalStore(cwd).create(candidate)));
    expect(results.map(({ status }) => status)).toEqual(['rejected', 'rejected', 'rejected']);
    const saved = JSON.parse(readFileSync(goalPath, 'utf-8'));
    expect(candidates).toContainEqual(saved);
    expect(saved).toEqual(record);
    expect(await new GoalStore(cwd).get(goalId)).toEqual(record);
    expect(readFileSync(goalPath)).toEqual(before);
  });

  it.each(['{', JSON.stringify({ id: goalId }), 'null'])('rejects corrupt content and preserves its bytes %#', async (content) => {
    mkdirSync(join(cwd, '.takt', 'goals', goalId), { recursive: true });
    writeFileSync(goalPath, content);
    const store = new GoalStore(cwd);
    await expect(store.get(goalId)).rejects.toThrow();
    const listed = await store.list();
    expect(listed.goals).toEqual([]);
    expect(listed.errors).toEqual([{ goalId, error: expect.any(Error) }]);
    await expect(store.create(goalRecord())).rejects.toThrow();
    expect(readFileSync(goalPath, 'utf-8')).toBe(content);
  });

  it.each([
    { content: '{', corruptFirst: true }, { content: '{', corruptFirst: false },
    { content: JSON.stringify({ id: goalId }), corruptFirst: true },
    { content: JSON.stringify({ id: goalId }), corruptFirst: false },
    { content: 'null', corruptFirst: true }, { content: 'null', corruptFirst: false },
  ])('lists healthy records alongside corruption without modifying either file %#', async ({ content, corruptFirst }) => {
    const nextId = '550e8400-e29b-41d4-a716-446655440001';
    const corruptId = corruptFirst ? goalId : nextId;
    const healthy = { ...goalRecord(), id: corruptFirst ? nextId : goalId, objective: '{' };
    const corruptPath = join(cwd, '.takt', 'goals', corruptId, 'goal.json');
    const healthyPath = join(cwd, '.takt', 'goals', healthy.id, 'goal.json');
    await new GoalStore(cwd).create(healthy);
    const saved = readFileSync(healthyPath);
    mkdirSync(join(cwd, '.takt', 'goals', corruptId), { recursive: true });
    writeFileSync(corruptPath, content);

    const store = new GoalStore(cwd);
    const listed = await store.list();
    expect(listed.goals).toEqual([healthy]);
    expect(listed.errors).toEqual([{ goalId: corruptId, error: expect.any(Error) }]);
    expect(listed.errors[0]!.error.message).toMatch(/Invalid goal file/);
    await expect(store.get(corruptId)).rejects.toThrow();
    await expect(store.create({ ...goalRecord(), id: corruptId })).rejects.toThrow();
    expect(await store.get(healthy.id)).toEqual(healthy);
    expect(readFileSync(corruptPath, 'utf-8')).toBe(content);
    expect(readFileSync(healthyPath)).toEqual(saved);
  });

  it('rejects an escaping goal ID before creating a file outside the goals directory', async () => {
    const store = new GoalStore(cwd);
    await expect(store.create({ ...goalRecord(), id: '../outside' })).rejects.toThrow();
    await expect(store.get('../outside')).rejects.toThrow();
    expect(existsSync(join(cwd, '.takt', 'outside', 'goal.json'))).toBe(false);
  });
});
