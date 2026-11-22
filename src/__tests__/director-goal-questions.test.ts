import { beforeEach, expect, it, vi } from 'vitest';
import { answerDirectorGoalQuestion, assertDirectorGoalTarget, changeDirectorGoalQuestionRoute, escalateDirectorGoalQuestion } from '../features/director/goalQuestions.js';
import { addGoalQuestion } from '../infra/goals/questions.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import type { AcceptedEvent } from '../core/daemon/events.js';
import type { Goal } from '../infra/goals/schema.js';
import { createTurnBusiness } from '../features/daemonTurn/turnBusiness.js';
import type { DirectorStateActions } from '../features/director/mcp.js';
import { turnStart } from './helpers/daemon-turn.js';
import { conversationId } from '../infra/conversations/identity.js';
const doubles = vi.hoisted(() => ({ manager: vi.fn<typeof import('../features/director/managers.js').resolveDirectorManager>(),
  update: vi.fn(), publish: vi.fn<typeof import('../infra/goals/answer-publication.js').answerGoalQuestionForPublication>(), runtime: vi.fn(), execute: vi.fn() }));
vi.mock('../features/director/managers.js', () => ({ resolveDirectorManager: doubles.manager }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { update = doubles.update; } }));
vi.mock('../infra/goals/answer-publication.js', () => ({ answerGoalQuestionForPublication: doubles.publish }));
vi.mock('../features/director/conversationRuntime.js', () => ({ createDaemonConversationRuntime: doubles.runtime }));
vi.mock('../features/manager/conversationService.js', () => ({ createConversationTurnService: () => ({ execute: doubles.execute }) }));
const target = { managerId: 'manager', cwd: '/assigned', goalId: goalRecord().id };
const signal = () => new AbortController().signal;
function event(): AcceptedEvent {
  return { eventId: 'event', requestId: 'request', conversationId: 'daemon', source: 'tui', occurredAt: '2026-11-18T00:00:00.000Z',
    operationId: 'operation', acceptedSequence: 1, lane: 'human', event: { kind: 'human_command',
      command: { kind: 'message', text: 'Delegate this goal' }, speaker: { namespace: 'tui-user', id: 'user' } } };
}
beforeEach(() => { vi.resetAllMocks(); doubles.manager.mockResolvedValue({ kind: 'repository', repositoryDirectory: '/assigned', repositoryDirectories: ['/assigned'] }); });
it('checks the selected manager repository before changing or answering a goal', async () => {
  doubles.manager.mockResolvedValue({ kind: 'repository', repositoryDirectory: '/other', repositoryDirectories: ['/other'] });
  await expect(assertDirectorGoalTarget('/config', target)).rejects.toThrow();
  await expect(answerDirectorGoalQuestion('/config', target, 'question', { text: 'answer' }, signal())).rejects.toThrow();
  expect(doubles.publish).not.toHaveBeenCalled();
});
it('uses one current locked goal to reroute all pending questions', async () => {
  const goal = addGoalQuestion(goalRecord(), { body: 'Choose' }).goal;
  doubles.update.mockImplementation(async (_id: string, transform: (goal: Goal) => Goal) => transform(goal));
  await expect(changeDirectorGoalQuestionRoute('/config', target, 'director', 'human', event(), signal())).resolves.toMatchObject({
    creationOrigin: 'manager', questionRoute: 'director',
  });
  expect(doubles.update).toHaveBeenCalledOnce();
});
it.each(['origin', 'autonomous', 'agent', 'source'] as const)('rejects a forged human route change from %s', async reason => {
  const accepted = event();
  if (reason === 'autonomous') accepted.event = { kind: 'patrol', goalIds: [] };
  if (reason === 'agent' && accepted.event.kind === 'human_command') accepted.event.speaker = { namespace: 'agent', id: 'director' };
  if (reason === 'source') accepted.source = 'director';
  await expect(changeDirectorGoalQuestionRoute('/config', target, 'director', reason === 'origin' ? 'director' : 'human', accepted, signal()))
    .rejects.toThrow();
  expect(doubles.update).not.toHaveBeenCalled();
});
it('records director authorship separately from the MCP transport', async () => {
  doubles.publish.mockResolvedValue({ answeredBy: 'director', source: 'mcp', text: 'Array', answeredAt: '2026-11-18T00:00:00.000Z' });
  await expect(answerDirectorGoalQuestion('/config', target, 'question', { text: 'Array' }, signal())).resolves.toMatchObject({ answeredBy: 'director' });
  expect(doubles.publish).toHaveBeenCalledExactlyOnceWith('/assigned', target.goalId, 'question', { text: 'Array' }, 'mcp', expect.any(Function), 'director');
});
it('distinguishes a saved answer awaiting delivery from a failed save', async () => {
  doubles.publish.mockImplementationOnce(async (_cwd, _goal, _question, _answer, _source, onSaved) => { onSaved(); throw new Error('inbox unavailable'); });
  await expect(answerDirectorGoalQuestion('/config', target, 'question', { text: 'Array' }, signal())).rejects.toThrow('Answer saved');
  doubles.publish.mockRejectedValueOnce(new Error('save unavailable'));
  await expect(answerDirectorGoalQuestion('/config', target, 'question', { text: 'Array' }, signal())).rejects.toThrow('save unavailable');
});
it('escalates the selected question while retaining the goal route', async () => {
  const pending = addGoalQuestion({ ...goalRecord(), questionRoute: 'director' }, { body: 'Unclear' });
  doubles.update.mockImplementation(async (_id: string, transform: (goal: Goal) => Goal) => transform(pending.goal));
  await expect(escalateDirectorGoalQuestion('/config', target, pending.questionId, signal())).resolves.toMatchObject({
    question: { questionType: 'unsure', recipient: 'human' },
  });
});
it('does not write after interruption', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(changeDirectorGoalQuestionRoute('/config', target, 'director', 'human', event(), controller.signal)).rejects.toThrow();
  await expect(escalateDirectorGoalQuestion('/config', target, 'question', controller.signal)).rejects.toThrow();
  await expect(answerDirectorGoalQuestion('/config', target, 'question', { text: 'Array' }, controller.signal)).rejects.toThrow();
  expect(doubles.update).not.toHaveBeenCalled(); expect(doubles.publish).not.toHaveBeenCalled();
});

it('binds route authorization to the actual active turn and clears it when that turn finishes', async () => {
  let actions!: DirectorStateActions;
  doubles.runtime.mockImplementation((_config: string, supplied: DirectorStateActions) => { actions = supplied; return { resolve: vi.fn(), close: vi.fn() }; });
  const pending = addGoalQuestion(goalRecord(), { body: 'Choose' }).goal;
  doubles.update.mockImplementation(async (_id: string, transform: (goal: Goal) => Goal) => transform(pending));
  doubles.execute.mockImplementation(async () => {
    await actions.setQuestionRoute(target, 'director', 'human');
    return { kind: 'completed', result: { kind: 'notice', message: '' } };
  });
  const business = await createTurnBusiness('/config', { kind: 'daemon' });
  const human = turnStart(); human.state.assignment = { kind: 'daemon' };
  human.turn.conversationId = conversationId(human.state.assignment);
  human.event.conversationId = human.turn.conversationId;
  const io = { signal: signal(), request: vi.fn(), progress: vi.fn() };
  await expect(business.execute(human, io)).resolves.toMatchObject({ kind: 'completed' });
  expect(doubles.update).toHaveBeenCalledOnce();
  const autonomous = { ...human, event: { ...human.event, source: 'watcher' as const, event: { kind: 'patrol' as const, goalIds: [] } } };
  await expect(business.execute(autonomous, io)).rejects.toThrow();
  expect(doubles.update).toHaveBeenCalledOnce();
  await expect(actions.setQuestionRoute(target, 'human', 'human')).rejects.toThrow();
  expect(doubles.update).toHaveBeenCalledOnce();
});
