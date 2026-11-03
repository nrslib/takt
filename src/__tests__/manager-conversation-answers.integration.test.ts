import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { answerConversationInquiry } from '../features/manager/conversationAnswers.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { GoalStore } from '../infra/goals/store.js';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import { createInquiry } from '../infra/goals/inquiry.js';
import { saveManagerToolPermissionInquiry } from '../features/manager/toolPermissionInquiry.js';
import { iteratePendingInquiries } from '../infra/goals/pending-inquiries.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import type { ConversationCommand } from '../features/manager/conversationPort.js';
import type { GoalQuestion } from '../infra/goals/schema.js';
import type { ManagerAssignment } from '../features/manager/startupResolution.js';
import * as repositories from '../infra/task/repositoryDirectory.js';
import { readScopedPermissions } from '../features/manager/scopedPermissionStorage.js';

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
  mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'goal.json'), JSON.stringify({ ...goalRecord(), questions: [value] }));
}
function answer(value = command) { return answerConversationInquiry(value, assignment, directory, new AbortController().signal, 'en'); }
async function pendingInquiries() {
  const items = [];
  for await (const item of iteratePendingInquiries(directory, assignment)) items.push(item);
  return items;
}
beforeEach(() => {
  vi.resetAllMocks();
  directory = getGlobalConfigDir(); repository = join(directory, 'repository'); mkdirSync(repository);
  assignment = { kind: 'repository', repositoryDirectory: repository, repositoryDirectories: [repository] };
  question = createInquiry({ kind: 'approval', body: 'Allow the operation?', operation: { toolName: 'Bash', args: '{"command":"git status"}', cwd: repository } });
  saveQuestion(question);
  command = { kind: 'answer_question', target: { goalId: goalRecord().id, repositoryDirectory: repository }, questionId: question.id,
    answer: { decision: 'allow', scope: 'global', text: 'Allow git status' }, permission: { scope: { kind: 'global' }, sentence: 'Allow git status' } };
});
afterEach(() => vi.restoreAllMocks());

it('saves a validated allow decision after its confirmed permission and publishes the answer event', async () => {
  expect(await answer()).toMatchObject({ kind: 'answer_saved', answerSaved: true });
  expect(readFileSync(join(directory, 'manager-permissions.md'), 'utf8')).toContain('- Allow git status');
  expect((await new GoalStore(repository).get(goalRecord().id)).questions![0]).toMatchObject({ status: 'answered', answer: { decision: 'allow', scope: 'global', source: 'tui' } });
  expect(doubles.event).toHaveBeenCalledExactlyOnceWith(repository, expect.objectContaining({ kind: 'answer', questionId: question.id }));
  expect(doubles.run).toHaveBeenCalledExactlyOnceWith(repository);
});

it('preserves Slack provenance through goal persistence and the answer event', async () => {
  const slackCommand = { ...command, source: 'slack' as const };
  expect(await answer(slackCommand)).toMatchObject({ kind: 'answer_saved', answerSaved: true });
  expect((await new GoalStore(repository).get(goalRecord().id)).questions![0]!.answer).toMatchObject({
    decision: 'allow', scope: 'global', source: 'slack',
  });
  expect(doubles.event).toHaveBeenCalledExactlyOnceWith(repository, expect.objectContaining({
    kind: 'answer', questionId: question.id, answer: expect.objectContaining({ source: 'slack' }),
  }));
});

it('preserves Slack provenance when answering a standalone inquiry through the shared answer handler', async () => {
  const owner = { kind: 'repository' as const, repositoryDirectory: repository };
  const inquiry = await saveManagerToolPermissionInquiry({
    request: { toolName: 'Bash', toolInput: { command: 'git status' }, cwd: repository },
    reason: 'Confirm this operation', configDirectory: directory, owner,
  });
  const slackCommand = { ...command, source: 'slack' as const, target: { goalId: null, owner },
    questionId: inquiry.id, permission: undefined, answer: { decision: 'allow' as const, scope: 'once' as const } };
  expect(await answer(slackCommand)).toMatchObject({ kind: 'answer_saved', answerSaved: true });
  expect(await new StandaloneInquiryStore(directory, owner).get(inquiry.id)).toMatchObject({
    status: 'answered', answer: { decision: 'allow', scope: 'once', source: 'slack' },
  });
  expect(existsSync(join(directory, 'manager-permissions.md'))).toBe(false);
});

it('normalizes the operation subdirectory to its assigned repository before appending project permission', async () => {
  const nested = join(repository, 'operation'); mkdirSync(nested);
  vi.spyOn(repositories, 'resolveGitRepositoryDirectory').mockImplementation(async (path) => path === nested ? repository : path);
  question = createInquiry({ kind: 'approval', body: 'Confirm this output',
    operation: { toolName: 'Write', args: '{}', cwd: nested } });
  saveQuestion(question);
  command = { ...command, questionId: question.id, answer: { decision: 'allow', scope: 'project' },
    permission: { scope: { kind: 'project', projectDirectory: nested }, sentence: 'Allow the selected output' } };
  expect(await answer()).toMatchObject({ kind: 'answer_saved', answerSaved: true });
  expect(await readScopedPermissions({ projectDirectory: repository })).toMatchObject({ ok: true,
    files: [{ scope: 'project', content: '## 許可\n- Allow the selected output\n' }] });
  expect(await readScopedPermissions({ projectDirectory: nested })).toEqual({ ok: true, files: [] });
});

it.each(['withdrawn', 'wrong-repository', 'wrong-owner', 'deny-with-permission', 'wrong-scope', 'multiline', 'report-for-approval'] as const)(
  'rejects %s before permission or answer side effects', async (invalid) => {
    if (invalid === 'withdrawn') saveQuestion({ ...question, status: 'withdrawn', withdrawnAt: new Date().toISOString() });
    if (invalid === 'wrong-repository') command.target = { goalId: goalRecord().id, repositoryDirectory: '/other' };
    if (invalid === 'wrong-owner') command.target = { goalId: null, owner: { kind: 'repository', repositoryDirectory: '/other' } };
    if (invalid === 'deny-with-permission') command.answer = { decision: 'deny' };
    if (invalid === 'wrong-scope') command.permission = { scope: { kind: 'workspace', workspaceId: '11111111-1111-4111-8111-111111111111' }, sentence: 'Allow git status' };
    if (invalid === 'multiline') command.permission!.sentence = 'allow\n## 拒否';
    if (invalid === 'report-for-approval') command.answer = { report: 'completed', text: 'done' };
    expect(await answer()).toMatchObject({ kind: 'error', answerSaved: false, permissionAppended: false });
    expect(existsSync(join(directory, 'manager-permissions.md'))).toBe(false);
    expect(doubles.event).not.toHaveBeenCalled(); expect(doubles.run).not.toHaveBeenCalled();
    expect((await new GoalStore(repository).get(goalRecord().id)).questions![0]!.status).toBe(invalid === 'withdrawn' ? 'withdrawn' : 'pending');
  },
);

it.each(['answer', 'event', 'run'] as const)('reports the exact partial success when %s fails without replaying it', async (failure) => {
  if (failure === 'answer') vi.spyOn(GoalStore.prototype, 'update').mockRejectedValueOnce(new Error('save failed'));
  if (failure === 'event') doubles.event.mockImplementationOnce(() => { throw new Error('event failed'); });
  if (failure === 'run') doubles.run.mockRejectedValueOnce(new Error('run failed'));
  expect(await answer()).toMatchObject({ kind: 'error', permissionAppended: true, answerSaved: failure !== 'answer' });
  expect(readFileSync(join(directory, 'manager-permissions.md'), 'utf8').match(/Allow git status/gu)).toHaveLength(1);
  expect((await new GoalStore(repository).get(goalRecord().id)).questions![0]!.status).toBe(failure === 'answer' ? 'pending' : 'answered');
  expect(doubles.event).toHaveBeenCalledTimes(failure === 'answer' ? 0 : 1);
  expect(doubles.run).toHaveBeenCalledTimes(failure === 'run' ? 1 : 0);
});

it('does not save an answer when permission persistence fails', async () => {
  mkdirSync(join(directory, 'manager-permissions.md'));
  expect(await answer()).toMatchObject({ kind: 'error', permissionAppended: false, answerSaved: false });
  expect((await new GoalStore(repository).get(goalRecord().id)).questions![0]!.status).toBe('pending');
  expect(doubles.event).not.toHaveBeenCalled();
});

it.each(['question', 'operation_request'] as const)('preserves structured %s answer semantics', async (kind) => {
  question = createInquiry({ kind, body: 'Please respond' }); saveQuestion(question);
  command.questionId = question.id; command.permission = undefined;
  command.answer = kind === 'question' ? { text: 'CSV' } : { report: 'unable', text: 'No access' };
  expect(await answer()).toMatchObject({ kind: 'answer_saved', answerSaved: true });
  expect((await new GoalStore(repository).get(goalRecord().id)).questions![0]!.answer).toMatchObject(command.answer);
});

it('reads and answers a normal standalone tool-permission inquiry without a fabricated options field', async () => {
  const owner = { kind: 'repository' as const, repositoryDirectory: repository };
  const inquiry = await saveManagerToolPermissionInquiry({ request: { toolName: 'Bash', toolInput: { command: 'git status' }, cwd: repository },
    reason: 'Confirm this operation', configDirectory: directory, owner });
  const pending = await pendingInquiries();
  expect(pending.find(({ goalId }) => goalId === null)?.question).toEqual(inquiry);
  expect(inquiry.options).toBeUndefined();
  command = { ...command, target: { goalId: null, owner }, questionId: inquiry.id, permission: undefined, answer: { decision: 'deny' } };
  expect(await answer()).toMatchObject({ kind: 'answer_saved', answerSaved: true });
  expect(await new StandaloneInquiryStore(directory, owner).get(inquiry.id)).toMatchObject({ status: 'answered', answer: { decision: 'deny' } });
  expect(doubles.event).not.toHaveBeenCalled(); expect(doubles.run).not.toHaveBeenCalled();
});

it('drops a withdrawn standalone inquiry from the next read and rejects its retained answer target', async () => {
  const owner = { kind: 'repository' as const, repositoryDirectory: repository };
  const store = new StandaloneInquiryStore(directory, owner);
  const inquiry = await store.create({ kind: 'approval', body: 'Confirm', operation: { cwd: repository, toolName: 'Bash', args: '{}' } });
  expect((await pendingInquiries()).some(({ question: item }) => item.id === inquiry.id)).toBe(true);
  await store.withdraw(inquiry.id, 'No longer needed');
  expect((await pendingInquiries()).some(({ question: item }) => item.id === inquiry.id)).toBe(false);
  expect(await answer({ ...command, target: { goalId: null, owner }, questionId: inquiry.id })).toMatchObject({ kind: 'error', answerSaved: false, permissionAppended: false });
});
