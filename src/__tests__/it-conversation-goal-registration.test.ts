import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { registerReservedGoal } from '../infra/goals/service.js';
import { readManagerEvents, saveManagerEvent } from '../infra/goals/events.js';
import { goalRecord, goalInput } from './helpers/goal-fixtures.js';

let repository: string;
function git(...args: string[]) { return execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim(); }
function request() { return { cwd: repository, ...goalInput(), id: goalRecord().id, startBranch: 'main', integrationBranch: 'main' }; }
function savedPath() { return join(repository, '.takt', 'goals', goalRecord().id, 'goal.json'); }
beforeEach(() => {
  repository = join(getGlobalConfigDir(), 'repository'); mkdirSync(repository);
  git('init', '-b', 'main');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
});

it('reuses the exact reserved goal without another branch, goal or registration event', async () => {
  const created = await registerReservedGoal(request());
  const refs = git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
  const events = readManagerEvents(repository);
  const bytes = readFileSync(savedPath());
  expect(await registerReservedGoal(request())).toEqual(created);
  expect(readFileSync(savedPath())).toEqual(bytes);
  expect(git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')).toBe(refs);
  expect(readManagerEvents(repository)).toEqual(events);
  expect(events.filter(({ event }) => event.kind === 'registered' && event.goalId === created.id)).toHaveLength(1);
  expect(readdirSync(join(repository, '.takt', 'goals'))).toEqual([created.id]);
});

it('reports a conflicting existing goal without overwriting it or issuing another event', async () => {
  await registerReservedGoal(request());
  const bytes = readFileSync(savedPath()); const events = readManagerEvents(repository);
  await expect(registerReservedGoal({ ...request(), objective: 'Different proposal' })).rejects.toMatchObject({ code: 'registration_recovery' });
  expect(readFileSync(savedPath())).toEqual(bytes); expect(readManagerEvents(repository)).toEqual(events);
});

it('reports a branch left before goal persistence without creating another timestamped branch', async () => {
  git('branch', `takt/20261024T0000-goal-${goalRecord().id.slice(0, 8)}`);
  const refs = git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
  await expect(registerReservedGoal(request())).rejects.toMatchObject({ code: 'registration_recovery' });
  expect(git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')).toBe(refs);
  expect(readManagerEvents(repository)).toEqual([]);
});

it('preserves an existing goal with ambiguous event delivery until its registration can be reconciled', async () => {
  const goal = goalRecord(); const path = savedPath(); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(goal));
  const bytes = readFileSync(path);
  await expect(registerReservedGoal(request())).rejects.toMatchObject({ code: 'registration_recovery' });
  expect(readFileSync(path)).toEqual(bytes); expect(readManagerEvents(repository)).toEqual([]);
  saveManagerEvent(repository, { kind: 'registered', goalId: goal.id });
  const events = readManagerEvents(repository);
  expect(await registerReservedGoal(request())).toEqual(goal);
  expect(readManagerEvents(repository)).toEqual(events); expect(readFileSync(path)).toEqual(bytes);
});

it('does not treat a corrupt saved goal as absence or start any new Git side effects', async () => {
  const path = savedPath(); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, '{broken');
  const refs = git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
  await expect(registerReservedGoal(request())).rejects.toThrow();
  expect(readFileSync(path, 'utf8')).toBe('{broken');
  expect(git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')).toBe(refs);
  expect(readManagerEvents(repository)).toEqual([]);
});
