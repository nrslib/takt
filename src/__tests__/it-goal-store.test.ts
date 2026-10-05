import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GoalStore } from '../infra/goals/store.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';

describe('GoalStore persistence', () => {
  let cwd: string;
  let goalPath: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-goal-store-'));
    goalPath = join(cwd, '.takt', 'goals', goalId, 'goal.json');
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

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
