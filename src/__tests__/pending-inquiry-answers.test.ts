import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import { publishPendingGoalAnswers, publishPendingInquiryAnswers } from '../features/daemon/pendingInquiryAnswers.js';
import { readManagerEvents } from '../infra/goals/events.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { GoalQuestionSchema } from '../infra/goals/schema.js';
import { GoalStore } from '../infra/goals/store.js';
import { goalRecord } from './helpers/goal-fixtures.js';

let directory: string | undefined;
afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

it('keeps a failed publication pending and clears it after a later accepted publication', async () => {
  directory = await mkdtemp(join(tmpdir(), 'takt-inquiry-outbox-'));
  const owner = { kind: 'workspace' as const, workspaceId: '750e8400-e29b-41d4-a716-446655440001' };
  const store = new StandaloneInquiryStore(directory, owner);
  const question = await store.create({ body: 'Which output format?' });
  await store.answerForPublication(question.id, { text: 'CSV' });
  const errors: unknown[] = [];
  const publish = vi.fn().mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue(undefined);

  await publishPendingInquiryAnswers(directory, [owner], publish, (error) => errors.push(error));
  expect(errors).toHaveLength(1);
  expect((await store.get(question.id)).answerPublicationPending).toBe(true);

  await publishPendingInquiryAnswers(directory, [owner], publish, (error) => errors.push(error));
  expect(publish).toHaveBeenCalledTimes(2);
  expect((await store.get(question.id)).answerPublicationPending).toBeUndefined();
});

it('reports one owner listing failure and continues publishing for later owners', async () => {
  directory = await mkdtemp(join(tmpdir(), 'takt-inquiry-outbox-'));
  const brokenOwner = { kind: 'workspace' as const, workspaceId: '750e8400-e29b-41d4-a716-446655440001' };
  const workingOwner = { kind: 'workspace' as const, workspaceId: '750e8400-e29b-41d4-a716-446655440002' };
  const brokenDirectory = join(directory, 'workspaces', brokenOwner.workspaceId, 'inquiries');
  await mkdir(brokenDirectory, { recursive: true });
  await writeFile(join(brokenDirectory, '650e8400-e29b-41d4-a716-446655440001.json'), '{');

  const store = new StandaloneInquiryStore(directory, workingOwner);
  const question = await store.create({ body: 'Which output format?' });
  await store.answerForPublication(question.id, { text: 'CSV' });
  const errors: unknown[] = [];
  const publish = vi.fn().mockResolvedValue(undefined);

  await publishPendingInquiryAnswers(directory, [brokenOwner, workingOwner], publish, (error) => errors.push(error));

  expect(errors).toHaveLength(1);
  expect(publish).toHaveBeenCalledExactlyOnceWith(workingOwner, expect.objectContaining({ id: question.id }));
  expect((await store.get(question.id)).answerPublicationPending).toBeUndefined();
});

it('reports one goal answer publication failure and continues publishing later goal answers', async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'takt-goal-answer-outbox-')));
  const answer = { text: 'CSV', source: 'tui' as const, answeredAt: '2026-11-01T00:00:00.000Z' };
  const question = GoalQuestionSchema.parse({ id: '650e8400-e29b-41d4-a716-446655440001', body: 'Which output format?',
    recipient: 'human', status: 'answered', answer, answerPublicationPending: true });
  const goal = await new GoalStore(directory).create({ ...goalRecord(), questions: [question] });
  const errors: unknown[] = [];

  await publishPendingGoalAnswers(getGlobalConfigDir(), [
    { repositoryDirectory: directory, goalId: '550e8400-e29b-41d4-a716-446655449999', question },
    { repositoryDirectory: directory, goalId: goal.id, question },
  ], (error) => errors.push(error));

  expect(errors).toHaveLength(1);
  expect(readManagerEvents(directory).map(({ event }) => event)).toEqual([
    expect.objectContaining({ kind: 'answer', goalId: goal.id, questionId: question.id, answer }),
  ]);
  expect((await new GoalStore(directory).get(goal.id)).questions![0]!.answerPublicationPending).toBeUndefined();
});

it('clears a pending goal answer without notifying the manager when the goal is aborted', async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'takt-goal-answer-outbox-')));
  const answer = { text: 'CSV', source: 'tui' as const, answeredAt: '2026-11-01T00:00:00.000Z' };
  const question = GoalQuestionSchema.parse({ id: '650e8400-e29b-41d4-a716-446655440001', body: 'Which output format?',
    recipient: 'human', status: 'answered', answer, answerPublicationPending: true });
  const goal = await new GoalStore(directory).create({ ...goalRecord(), executionStatus: 'aborted', questions: [question] });
  const errors: unknown[] = [];

  await publishPendingGoalAnswers(getGlobalConfigDir(), [{ repositoryDirectory: directory, goalId: goal.id, question }],
    (error) => errors.push(error));

  expect(errors).toEqual([]);
  expect(readManagerEvents(directory)).toEqual([]);
  expect((await new GoalStore(directory).get(goal.id)).questions![0]!.answerPublicationPending).toBeUndefined();
});
