import { beforeEach, expect, it, vi } from 'vitest';
import { resolveDirectorNotificationSubject, directorNotificationTargetSchema } from '../features/director/notificationTarget.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import type { Goal } from '../infra/goals/schema.js';

const doubles = vi.hoisted(() => ({ manager: vi.fn(), goal: vi.fn(), inquiry: vi.fn() }));
vi.mock('../features/director/managers.js', () => ({ resolveDirectorManager: doubles.manager }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.goal; } }));
vi.mock('../infra/goals/standalone-inquiries.js', () => ({ StandaloneInquiryStore: class { get = doubles.inquiry; } }));
const target = { managerId: `manager-${'a'.repeat(64)}`, cwd: '/repository', goalId: goalRecord().id };
const question = { id: '11111111-1111-4111-8111-111111111111', status: 'pending', recipient: 'human', body: 'Decide specification', createdAt: '2026-10-28T00:00:00Z' };
let goal: Goal;
beforeEach(() => {
  vi.resetAllMocks();
  goal = { ...goalRecord(), createdAt: '2026-10-28T00:00:00Z', questions: [question as NonNullable<Goal['questions']>[number]] };
  doubles.goal.mockImplementation(async () => goal);
  doubles.manager.mockResolvedValue({ kind: 'repository', repositoryDirectory: '/repository', repositoryDirectories: ['/repository'] });
  doubles.inquiry.mockResolvedValue(question);
});

it('uses saved state and ignores patrol timestamps and records while noticing actual progress', async () => {
  const first = await resolveDirectorNotificationSubject('/config', target);
  expect(JSON.parse(first.state).lastProgressAt).toBe(goal.createdAt);
  goal.lastPatrolCompletedAt = '2026-10-29T00:00:00Z';
  goal.workLog.push({ id: question.id, kind: 'patrol', summary: 'Checked', recordedAt: '2026-10-29T00:00:00Z' });
  expect(await resolveDirectorNotificationSubject('/config', target)).toEqual(first);
  goal.workLog.push({ id: question.id, summary: 'Real progress', recordedAt: '2026-10-29T01:00:00Z' });
  expect((await resolveDirectorNotificationSubject('/config', target)).state).not.toBe(first.state);
  goal.executionStatus = 'paused';
  expect(JSON.parse((await resolveDirectorNotificationSubject('/config', target)).state).executionStatus).toBe('paused');
});

it('distinguishes repositories and pending inquiry identities', async () => {
  doubles.manager.mockResolvedValue({ repositoryDirectories: ['/repository', '/other'] });
  const first = await resolveDirectorNotificationSubject('/config', target);
  expect((await resolveDirectorNotificationSubject('/config', { ...target, cwd: '/other' })).key).not.toBe(first.key);
  const inquiry = await resolveDirectorNotificationSubject('/config', { ...target, inquiryId: question.id });
  expect(inquiry.key).not.toBe(first.key);
  expect(JSON.parse(inquiry.state)).toEqual(question);
  expect(await resolveDirectorNotificationSubject('/config', { managerId: target.managerId, inquiryId: question.id })).toMatchObject({ state: inquiry.state });
  expect(doubles.inquiry).toHaveBeenCalledWith(question.id);
});

it('keeps missing and empty blocked notifications equivalent when unrelated notifications appear', async () => {
  goal.executionStatus = 'paused';
  const first = await resolveDirectorNotificationSubject('/config', target);
  goal.notifications = [];
  expect(await resolveDirectorNotificationSubject('/config', target)).toEqual(first);
  goal.notifications.push({ id: question.id, kind: 'progress', body: 'Routine progress', recordedAt: '2026-10-29T00:00:00Z' });
  expect(await resolveDirectorNotificationSubject('/config', target)).toEqual(first);
  goal.notifications.push({ id: '22222222-2222-4222-8222-222222222222', kind: 'blocked', body: 'A new blocker', recordedAt: '2026-10-29T01:00:00Z' });
  expect((await resolveDirectorNotificationSubject('/config', target)).state).not.toBe(first.state);
});

it('rejects a repository outside the manager before reading the goal', async () => {
  await expect(resolveDirectorNotificationSubject('/config', { ...target, cwd: '/outside' })).rejects.toThrow('outside');
  expect(doubles.goal).not.toHaveBeenCalled();
});

it.each(['answered', 'withdrawn'])('rejects an unavailable human inquiry: %s', async (state) => {
  const saved = { ...question, status: state };
  goal.questions = [saved as NonNullable<Goal['questions']>[number]];
  doubles.inquiry.mockResolvedValue(saved);
  await expect(resolveDirectorNotificationSubject('/config', { ...target, inquiryId: question.id })).rejects.toThrow('pending');
  await expect(resolveDirectorNotificationSubject('/config', { managerId: target.managerId, inquiryId: question.id })).rejects.toThrow('pending');
});

it('rejects a missing goal inquiry', async () => {
  goal.questions = [];
  await expect(resolveDirectorNotificationSubject('/config', { ...target, inquiryId: question.id })).rejects.toThrow('pending');
});

it.each(['manager', 'goal', 'inquiry'] as const)('propagates %s read failure instead of treating it as an empty state', async (boundary) => {
  doubles[boundary].mockRejectedValueOnce(new Error('read failed'));
  const input = boundary === 'inquiry' ? { managerId: target.managerId, inquiryId: question.id } : target;
  await expect(resolveDirectorNotificationSubject('/config', input)).rejects.toThrow('read failed');
});

it('validates identifiers and requires an absolute repository or a standalone inquiry', () => {
  expect(directorNotificationTargetSchema.safeParse(target).success).toBe(true);
  for (const input of [{ ...target, cwd: 'relative' }, { ...target, goalId: 'unknown' }, { managerId: target.managerId }, { ...target, state: 'invented' }]) {
    expect(directorNotificationTargetSchema.safeParse(input).success).toBe(false);
  }
});
