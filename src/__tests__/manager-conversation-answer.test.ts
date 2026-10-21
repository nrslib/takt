import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagerConversationSession } from '../features/manager/conversationSession.js';
import { MockProvider } from '../infra/providers/mock.js';
import type { Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ assignment: vi.fn(), update: vi.fn(), event: vi.fn(), daemon: vi.fn(), run: vi.fn() }));
vi.mock('../features/manager/assignment.js', async (original) => ({
  ...await original<typeof import('../features/manager/assignment.js')>(), resolveCurrentManagerAssignment: doubles.assignment,
}));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class {
  constructor(private readonly directory: string) {}
  update(id: string, transform: (goal: Goal) => Goal, onSaved?: () => void) { return doubles.update(this.directory, id, transform, onSaved); }
} }));
vi.mock('../infra/goals/events.js', () => ({ saveManagerEvent: doubles.event }));
vi.mock('../features/daemon/lifecycle.js', () => ({ ensureDaemon: doubles.daemon }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: doubles.run }));

const cwd = '/repository-a';
const other = '/repository-b';
const questionId = '650e8400-e29b-41d4-a716-446655440001';
const assignment = { kind: 'workspace' as const, workspaceId: 'workspace', name: 'Workspace', repositoryDirectories: [cwd, other] };
const question = { id: questionId, kind: 'question' as const, recipient: 'human' as const, status: 'pending' as const, body: 'Format?' };
const options = { goalId: goalRecord().id, repositoryDirectory: cwd, questionId, answer: { text: 'CSV' } };

function fixture() {
  const goals = new Map<string, Goal>([cwd, other].map((directory) => [directory, { ...goalRecord(), questions: [question] }]));
  doubles.update.mockImplementation(async (directory: string, _id: string, transform: (goal: Goal) => Goal, onSaved?: () => void) => {
    const goal = transform(goals.get(directory)!);
    goals.set(directory, goal);
    onSaved?.();
    return goal;
  });
  const session = createManagerConversationSession({ cwd, assignment: { kind: 'workspace', workspaceId: 'workspace' },
    plan: { ctx: { providerType: 'mock', provider: new MockProvider(), model: undefined, lang: 'en' },
      strategy: { systemPrompt: 'manager fixture' } } });
  return { session, goals };
}

beforeEach(() => {
  vi.resetAllMocks();
  doubles.assignment.mockResolvedValue(assignment);
});

describe('manager answer persistence', () => {
  it('checks the latest assignment and keeps the selected repository when another repository has the same goal ID', async () => {
    const { session, goals } = fixture();
    const untouched = structuredClone(goals.get(other));
    const appendPermission = vi.fn(async () => {});
    try {
      expect(await session.answerQuestion({ ...options, appendPermission })).toMatchObject({ kind: 'reply', answerSaved: true });
      expect(appendPermission).toHaveBeenCalledExactlyOnceWith(assignment);
      expect(appendPermission.mock.invocationCallOrder[0]).toBeLessThan(doubles.update.mock.invocationCallOrder[0]!);
      expect(goals.get(cwd)!.questions![0]).toMatchObject({ status: 'answered', answer: { text: 'CSV', source: 'tui' } });
      expect(goals.get(other)).toEqual(untouched);
      expect(doubles.event).toHaveBeenCalledWith(cwd, expect.objectContaining({ kind: 'answer' }));
      expect(doubles.run).toHaveBeenCalledExactlyOnceWith(cwd);
    } finally { await session.close(); }
  });

  it('rejects the retained target after its repository leaves the same session assignment without retargeting the duplicate goal', async () => {
    const { session, goals } = fixture();
    const before = structuredClone(goals);
    const appendPermission = vi.fn(async () => {});
    try {
      expect(await session.getAssignment()).toEqual(assignment);
      doubles.assignment.mockResolvedValue({ ...assignment, repositoryDirectories: [other] });
      expect(await session.answerQuestion({ ...options, appendPermission })).toMatchObject({ kind: 'error', answerSaved: false });
      expect(appendPermission).not.toHaveBeenCalled();
      expect(doubles.update).not.toHaveBeenCalled();
      expect(goals).toEqual(before);
      for (const effect of [doubles.event, doubles.daemon, doubles.run]) expect(effect).not.toHaveBeenCalled();
    } finally { await session.close(); }
  });

  it.each(['event', 'daemon', 'run'] as const)('reports an already saved answer when %s fails afterwards', async (failure) => {
    const { session, goals } = fixture();
    if (failure === 'event') doubles.event.mockImplementationOnce(() => { throw new Error('post-save failure'); });
    else doubles[failure].mockRejectedValueOnce(new Error('post-save failure'));
    try {
      expect(await session.answerQuestion(options)).toMatchObject({ kind: 'error', answerSaved: true });
      expect(goals.get(cwd)!.questions![0]).toMatchObject({ status: 'answered', answer: { text: 'CSV', source: 'tui' } });
      if (failure !== 'run') expect(doubles.run).not.toHaveBeenCalled();
      if (failure === 'event') expect(doubles.daemon).not.toHaveBeenCalled();
    } finally { await session.close(); }
  });

  it.each(['permission', 'update', 'abort', 'closed'] as const)('reports an unsaved answer for %s failure without subsequent effects', async (failure) => {
    const { session, goals } = fixture();
    const before = structuredClone(goals);
    const controller = new AbortController();
    const appendPermission = vi.fn(async () => {
      if (failure === 'permission') throw new Error('append failure');
    });
    if (failure === 'update') doubles.update.mockRejectedValueOnce(new Error('save failure'));
    if (failure === 'abort') controller.abort();
    if (failure === 'closed') await session.close();
    try {
      expect(await session.answerQuestion({ ...options, appendPermission, abortSignal: controller.signal }))
        .toMatchObject({ kind: 'error', answerSaved: false });
      expect(goals).toEqual(before);
      if (failure !== 'update') expect(doubles.update).not.toHaveBeenCalled();
      for (const effect of [doubles.event, doubles.daemon, doubles.run]) expect(effect).not.toHaveBeenCalled();
    } finally { await session.close(); }
  });
});
