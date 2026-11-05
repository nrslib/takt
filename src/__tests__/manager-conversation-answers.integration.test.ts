import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { answerConversationInquiry } from '../features/manager/conversationAnswers.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { GoalStore } from '../infra/goals/store.js';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import { createInquiry } from '../infra/goals/inquiry.js';
import { iteratePendingInquiries } from '../infra/goals/pending-inquiries.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import type { ConversationCommand } from '../features/manager/conversationPort.js';
import type { GoalQuestion } from '../infra/goals/schema.js';
import type { ManagerAssignment } from '../features/manager/startupResolution.js';

const doubles = vi.hoisted(() => ({ event: vi.fn(), run: vi.fn() }));
vi.mock('../infra/goals/events.js', async (original) => ({ ...await original<typeof import('../infra/goals/events.js')>(), saveManagerEvent: doubles.event }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: doubles.run }));
let directory: string;
let repository: string;
let assignment: ManagerAssignment;
let question: GoalQuestion;
let command: Extract<ConversationCommand, { kind: 'answer_question' }>;
function saveQuestion(value: GoalQuestion) {
  const path = join(repository, '.takt', 'goals', goalRecord().id);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'goal.json'), JSON.stringify({ ...goalRecord(), questions: [value] }));
}
function answer(value = command) {
  return answerConversationInquiry(value, assignment, directory, new AbortController().signal, 'en');
}
async function pendingInquiries() {
  const items = [];
  for await (const item of iteratePendingInquiries(directory, assignment)) items.push(item);
  return items;
}
beforeEach(() => {
  vi.resetAllMocks();
  directory = getGlobalConfigDir();
  repository = join(directory, 'repository');
  mkdirSync(repository);
  assignment = { kind: 'repository', repositoryDirectory: repository, repositoryDirectories: [repository] };
  question = createInquiry({ body: 'Which output format?', options: ['CSV', 'JSON'] });
  saveQuestion(question);
  command = { kind: 'answer_question', target: { goalId: goalRecord().id, repositoryDirectory: repository },
    questionId: question.id, answer: { text: 'CSV' } };
});
afterEach(() => vi.restoreAllMocks());

it.each(['tui', 'slack'] as const)('saves a normal answer with %s provenance and publishes it without a permission file', async (source) => {
  expect(await answer({ ...command, source })).toMatchObject({ kind: 'answer_saved', answerSaved: true });
  expect((await new GoalStore(repository).get(goalRecord().id)).questions![0]).toMatchObject({ status: 'answered', answer: { text: 'CSV', source } });
  expect(doubles.event).toHaveBeenCalledExactlyOnceWith(repository, expect.objectContaining({ kind: 'answer', questionId: question.id,
    answer: expect.objectContaining({ text: 'CSV', source }) }));
  expect(doubles.run).toHaveBeenCalledExactlyOnceWith(repository);
  expect(existsSync(join(directory, 'manager-permissions.md'))).toBe(false);
});

it.each(['withdrawn', 'wrong-repository', 'wrong-owner', 'invalid-answer', 'historical-approval'] as const)(
  'rejects %s without saving an answer or causing follow-up effects', async (condition) => {
    if (condition === 'withdrawn') saveQuestion({ ...question, status: 'withdrawn' });
    if (condition === 'historical-approval') saveQuestion(createInquiry({ kind: 'approval', body: 'Old approval',
      operation: { toolName: 'Bash', args: '{}', cwd: repository } }));
    if (condition === 'wrong-repository') assignment = { ...assignment, repositoryDirectories: [] };
    const input = condition === 'wrong-owner' ? { ...command, target: { goalId: null, owner: { kind: 'workspace' as const,
      workspaceId: '750e8400-e29b-41d4-a716-446655440001' } } }
      : condition === 'invalid-answer' ? { ...command, answer: { report: 'completed' as const } } : command;
    const before = await new GoalStore(repository).get(goalRecord().id);
    expect(await answer(input)).toMatchObject({ kind: 'error', answerSaved: false });
    expect(await new GoalStore(repository).get(goalRecord().id)).toEqual(before);
    expect(doubles.event).not.toHaveBeenCalled();
    expect(doubles.run).not.toHaveBeenCalled();
  },
);

it.each(['answer', 'event', 'run'] as const)('reports the actual partial success after %s failure', async (failure) => {
  if (failure === 'answer') vi.spyOn(GoalStore.prototype, 'update').mockRejectedValueOnce(new Error('write failed'));
  if (failure === 'event') doubles.event.mockImplementationOnce(() => { throw new Error('event failed'); });
  if (failure === 'run') doubles.run.mockRejectedValueOnce(new Error('run failed'));
  expect(await answer()).toMatchObject({ kind: 'error', answerSaved: failure !== 'answer' });
  expect((await new GoalStore(repository).get(goalRecord().id)).questions![0]!.status).toBe(failure === 'answer' ? 'pending' : 'answered');
  if (failure !== 'run') expect(doubles.run).not.toHaveBeenCalled();
});

it.each(['question', 'operation_request'] as const)('preserves %s answer semantics', async (kind) => {
  question = createInquiry({ kind, body: 'Please confirm the result' });
  saveQuestion(question);
  const value = kind === 'question' ? { text: 'CSV' } : { report: 'completed' as const, text: 'Done' };
  expect(await answer({ ...command, questionId: question.id, answer: value })).toMatchObject({ kind: 'answer_saved' });
  expect((await new GoalStore(repository).get(goalRecord().id)).questions![0]!.answer).toMatchObject(value);
});

it('answers a standalone question with Slack provenance and removes it from pending inquiries', async () => {
  const owner = { kind: 'repository' as const, repositoryDirectory: repository };
  const store = new StandaloneInquiryStore(directory, owner);
  const inquiry = await store.create({ body: 'Which destination?' });
  expect((await pendingInquiries()).some(({ question }) => question.id === inquiry.id)).toBe(true);
  expect(await answer({ ...command, target: { goalId: null, owner }, questionId: inquiry.id, source: 'slack' }))
    .toMatchObject({ kind: 'answer_saved' });
  expect((await store.get(inquiry.id)).answer).toMatchObject({ text: 'CSV', source: 'slack' });
  expect((await pendingInquiries()).some(({ question }) => question.id === inquiry.id)).toBe(false);
});

it('rejects a retained answer target after standalone withdrawal', async () => {
  const owner = { kind: 'repository' as const, repositoryDirectory: repository };
  const store = new StandaloneInquiryStore(directory, owner);
  const inquiry = await store.create({ body: 'Which destination?' });
  await store.withdraw(inquiry.id, 'No longer needed');
  expect(await answer({ ...command, target: { goalId: null, owner }, questionId: inquiry.id })).toMatchObject({ kind: 'error', answerSaved: false });
  expect((await store.get(inquiry.id)).status).toBe('withdrawn');
});
