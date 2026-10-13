import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deleteGoalEvents, deleteManagerEvent, readManagerEvents, saveManagerEvent } from '../infra/goals/events.js';
import { GoalStore } from '../infra/goals/store.js';
import { goalRecord } from './helpers/goal-fixtures.js';
let root: string;
let project: string;
let other: string;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-inbox-'))); project = join(root, 'project'); other = join(root, 'other');
  mkdirSync(project); mkdirSync(other); vi.stubEnv('TAKT_CONFIG_DIR', join(root, 'global'));
  await new GoalStore(project).create(goalRecord()); await new GoalStore(other).create(goalRecord());
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
it('publishes separate JSON events in the configured global project inbox and removes only processed files', () => {
  saveManagerEvent(project, { kind: 'registered', goalId: goalRecord().id });
  saveManagerEvent(project, { kind: 'completion', goalId: goalRecord().id, taskName: 'task-a', runSlug: 'run-a', result: { success: true, interrupted: false, sha: 'a'.repeat(40) } });
  const saved = readManagerEvents(project);
  expect(saved).toHaveLength(2); expect(saved.every(({ filePath }) => filePath.startsWith(join(root, 'global', 'manager-inbox')))).toBe(true);
  expect(readManagerEvents(other)).toEqual([]);
  expect(readdirSync(dirname(saved[0]!.filePath)).every((name) => name.endsWith('.json'))).toBe(true);
  const completion = saved.find(({ event }) => event.kind === 'completion')!;
  expect(completion.event).toMatchObject({ goalId: goalRecord().id, taskName: 'task-a', runSlug: 'run-a', result: { success: true, sha: 'a'.repeat(40) } });
  deleteManagerEvent(completion); expect(existsSync(completion.filePath)).toBe(false); expect(readManagerEvents(project)).toHaveLength(1);
});
it('ignores unpublished temporary files and leaves events intact without a TUI', () => {
  saveManagerEvent(project, { kind: 'registered', goalId: goalRecord().id });
  const saved = readManagerEvents(project);
  writeFileSync(join(dirname(saved[0]!.filePath), 'unpublished.json.tmp'), '{');
  expect(readManagerEvents(project)).toEqual(saved); expect(readManagerEvents(project)).toEqual(saved);
});
it('removes an aborted goal events and preserves events belonging to other goals', async () => {
  const otherId = '550e8400-e29b-41d4-a716-446655440001';
  await new GoalStore(project).create({ ...goalRecord(), id: otherId });
  saveManagerEvent(project, { kind: 'registered', goalId: goalRecord().id }); saveManagerEvent(project, { kind: 'registered', goalId: otherId });
  deleteGoalEvents(project, goalRecord().id);
  expect(readManagerEvents(project).map(({ event }) => event.goalId)).toEqual([otherId]);
  await new GoalStore(project).update(otherId, (goal) => ({ ...goal, executionStatus: 'aborted' }));
  saveManagerEvent(project, { kind: 'completion', goalId: otherId, taskName: 'ended', runSlug: 'ended-run', result: { success: false, interrupted: true } });
  expect(readManagerEvents(project)).toHaveLength(1);
});
