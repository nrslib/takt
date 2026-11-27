vi.mock('../infra/goals/events.js', async (original) => ({ ...await original<typeof import('../infra/goals/events.js')>(), saveManagerEvent: vi.fn() }));
import { spawn } from 'node:child_process';
import { existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { GoalStore } from '../infra/goals/store.js';
import { goalId,goalRecord } from './helpers/goal-fixtures.js';
import { captureOwnedChild, terminateOwnedProcess, type OwnedProcess } from './helpers/owned-process.js';

describe('GoalStore persistence', () => {
  let cwd: string;
  let goalPath: string;
  let owned: OwnedProcess[];

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-goal-store-'));
    goalPath = join(cwd, '.takt', 'goals', goalId, 'goal.json');
    owned = [];
  });

  afterEach(async () => {
    for (const child of owned) await terminateOwnedProcess(child, () => false);
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('preserves both processes work log additions when updates overlap', async () => {
    const store = new GoalStore(cwd);
    await store.create(goalRecord());
    const moduleUrl = pathToFileURL(join(process.cwd(), 'dist/infra/goals/store.js')).href;
    const script = `
      import { randomUUID } from 'node:crypto';
      import { GoalStore } from ${JSON.stringify(moduleUrl)};
      const [cwd, id, label] = process.argv.slice(1);
      const store = new GoalStore(cwd);
      const buffer = new Int32Array(new SharedArrayBuffer(4));
      for (let index = 0; index < 5; index++) {
        await store.update(id, (goal) => {
          Atomics.wait(buffer, 0, 0, 100);
          return { ...goal, workLog: [...goal.workLog, {
            id: randomUUID(), summary: label + ':' + index, recordedAt: new Date().toISOString(),
          }] };
        });
      }
    `;
    const children = ['first', 'second'].map((label) => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', script, cwd, goalId, label], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
      const exited = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Goal update process exited (${code}): ${stderr}`));
        });
      });
      return { child, exited };
    });
    await Promise.all(children.map(async ({ child, exited }) => {
      const captured = await captureOwnedChild(child);
      if (captured !== undefined) owned.push(captured);
      await exited;
    }));
    const saved = await store.get(goalId);
    expect(saved.workLog.map((entry) => entry.summary).sort()).toEqual(
      ['first', 'second'].flatMap((label) => Array.from({ length: 5 }, (_, index) => `${label}:${index}`)),
    );
    expect(existsSync(`${goalPath}.lock`)).toBe(false);
  });

  it('releases the goal lock after a failed transform and preserves the previous record', async () => {
    const store = new GoalStore(cwd);
    await store.create(goalRecord());
    const before = readFileSync(goalPath);
    const failure = new Error('transform failed');
    await expect(store.update(goalId, () => { throw failure; })).rejects.toBe(failure);
    expect(readFileSync(goalPath)).toEqual(before);
    expect(existsSync(`${goalPath}.lock`)).toBe(false);
    await store.update(goalId, (goal) => ({ ...goal, objective: 'updated' }));
    expect((await store.get(goalId)).objective).toBe('updated');
  });

  it('rejects invalid new-format state rather than treating it as a legacy goal', async () => {
    mkdirSync(join(cwd, '.takt', 'goals', goalId), { recursive: true });
    writeFileSync(goalPath, JSON.stringify({ ...goalRecord(), executionStatus: 'unknown' }));
    await expect(new GoalStore(cwd).get(goalId)).rejects.toThrow();
  });

  it('roundtrips all required saved values', async () => {
    const record = goalRecord();
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
