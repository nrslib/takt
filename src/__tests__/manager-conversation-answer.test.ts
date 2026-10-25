import { beforeEach, describe, expect, it, vi } from 'vitest';
import { answerConversationInquiry } from '../features/manager/conversationAnswers.js';
import type { ConversationCommand } from '../features/manager/conversationPort.js';
import type { Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), event: vi.fn(), run: vi.fn(), append: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class {
  constructor(private readonly directory: string) {}
  get(id: string) { return doubles.get(this.directory, id); }
  update(id: string, transform: (goal: Goal) => Goal, onSaved?: () => void) { return doubles.update(this.directory, id, transform, onSaved); }
} }));
vi.mock('../infra/goals/events.js', () => ({ saveManagerEvent: doubles.event }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: doubles.run }));
vi.mock('../features/manager/scopedPermissionStorage.js', () => ({ appendScopedPermission: doubles.append }));

const cwd = '/repository-a';
const other = '/repository-b';
const questionId = '650e8400-e29b-41d4-a716-446655440001';
const assignment = { kind: 'workspace' as const, workspaceId: '750e8400-e29b-41d4-a716-446655440001',
  name: 'Workspace', repositoryDirectories: [cwd, other] };
const question = { id: questionId, kind: 'question' as const, recipient: 'human' as const,
  status: 'pending' as const, body: 'Format?' };
const command: Extract<ConversationCommand, { kind: 'answer_question' }> = { kind: 'answer_question',
  target: { goalId: goalRecord().id, repositoryDirectory: cwd }, questionId, answer: { text: 'CSV' } };
function fixture() {
  const goals = new Map<string, Goal>([cwd, other].map((directory) => [directory, { ...goalRecord(), questions: [question] }]));
  doubles.get.mockImplementation(async (directory: string) => goals.get(directory)!);
  doubles.update.mockImplementation(async (directory: string, _id: string, transform: (goal: Goal) => Goal, onSaved?: () => void) => {
    const goal = transform(goals.get(directory)!);
    goals.set(directory, goal);
    onSaved?.();
    return goal;
  });
  const answer = (value = command, current = assignment, signal = new AbortController().signal) =>
    answerConversationInquiry(value, current, '/config', signal, 'en');
  return { goals, answer };
}
beforeEach(() => { vi.resetAllMocks(); });

describe('daemon answer persistence', () => {
  it('keeps the selected repository when another assigned repository has the same goal ID', async () => {
    const { goals, answer } = fixture();
    const untouched = structuredClone(goals.get(other));
    expect(await answer()).toMatchObject({ kind: 'answer_saved', answerSaved: true });
    expect(goals.get(cwd)!.questions![0]).toMatchObject({ status: 'answered', answer: { text: 'CSV', source: 'tui' } });
    expect(goals.get(other)).toEqual(untouched);
    expect(doubles.append).not.toHaveBeenCalled();
    expect(doubles.event).toHaveBeenCalledWith(cwd, expect.objectContaining({ kind: 'answer' }));
    expect(doubles.run).toHaveBeenCalledExactlyOnceWith(cwd);
  });

  it('rejects the retained target after its repository leaves the assignment without retargeting the duplicate goal', async () => {
    const { goals, answer } = fixture();
    const before = structuredClone(goals);
    expect(await answer(command, { ...assignment, repositoryDirectories: [other] }))
      .toMatchObject({ kind: 'error', code: 'invalid_assignment', answerSaved: false, permissionAppended: false });
    expect(doubles.update).not.toHaveBeenCalled();
    expect(goals).toEqual(before);
    for (const effect of [doubles.append, doubles.event, doubles.run]) expect(effect).not.toHaveBeenCalled();
  });

  it.each(['event', 'run'] as const)('reports an already saved answer when %s fails afterwards', async (failure) => {
    const { goals, answer } = fixture();
    if (failure === 'event') doubles.event.mockImplementationOnce(() => { throw new Error('post-save failure'); });
    else doubles.run.mockRejectedValueOnce(new Error('post-save failure'));
    expect(await answer()).toMatchObject({ kind: 'error', answerSaved: true });
    expect(goals.get(cwd)!.questions![0]).toMatchObject({ status: 'answered', answer: { text: 'CSV', source: 'tui' } });
    if (failure === 'event') expect(doubles.run).not.toHaveBeenCalled();
  });

  it.each(['permission', 'update', 'abort'] as const)('reports exact partial success for %s failure without later effects', async (failure) => {
    const { goals, answer } = fixture();
    const approval = { ...question, kind: 'approval' as const,
      operation: { toolName: 'Write', args: '{}', argsDigest: '0'.repeat(64), cwd } };
    goals.set(cwd, { ...goalRecord(), questions: [approval] });
    const before = structuredClone(goals);
    const controller = new AbortController();
    const input = { ...command, answer: { decision: 'allow' as const, scope: 'global' as const },
      permission: { scope: { kind: 'global' as const }, sentence: 'Allow writing the selected output' } };
    if (failure === 'permission') doubles.append.mockRejectedValueOnce(new Error('append failure'));
    if (failure === 'update') doubles.update.mockRejectedValueOnce(new Error('save failure'));
    if (failure === 'abort') controller.abort();
    expect(await answer(input, assignment, controller.signal)).toMatchObject({
      kind: 'error', answerSaved: false, permissionAppended: failure === 'update',
    });
    expect(goals).toEqual(before);
    if (failure !== 'update') expect(doubles.update).not.toHaveBeenCalled();
    for (const effect of [doubles.event, doubles.run]) expect(effect).not.toHaveBeenCalled();
    if (failure === 'update') {
      expect(doubles.append).toHaveBeenCalledExactlyOnceWith({ scope: { kind: 'global' },
        heading: '許可', sentence: input.permission.sentence });
      expect(doubles.append.mock.invocationCallOrder[0]).toBeLessThan(doubles.update.mock.invocationCallOrder[0]!);
    }
  });
});
