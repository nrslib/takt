import { describe, expect, it } from 'vitest';
import { buildManagerEventPrompt, managerInboxTurnEvent } from '../features/daemon/inboxEvent.js';
import type { ManagerEvent } from '../infra/goals/events.js';
import { ManagerEventSchema } from '../infra/goals/events.js';
import { inquiryAnswerEvent } from '../features/daemon/inquiryAnswerEvent.js';

const common = { goalId: '650e8400-e29b-41d4-a716-446655440000', createdAt: '2026-11-01T00:00:00.000Z' };
const directory = '/workspace/project';

describe('managerInboxTurnEvent', () => {
  it('preserves a standalone human answer and its saved question through director delivery', () => {
    const answer = { text: 'CSV', answeredAt: common.createdAt, source: 'slack' };
    const saved = ManagerEventSchema.parse({ ...common, kind: 'answer', goalId: null,
      questionId: '650e8400-e29b-41d4-a716-446655440002', questionBody: 'Which format?', answer }) as Extract<ManagerEvent, { kind: 'answer' }>;
    expect(managerInboxTurnEvent(directory, saved)).toEqual(inquiryAnswerEvent(saved.questionId, saved.answer, saved.questionBody));
    expect(managerInboxTurnEvent(directory, saved)).toMatchObject({ inquiryAnswer: {
      questionId: saved.questionId, question: 'Which format?', answer,
    } });
  });
  it('rejects legacy patrol events that the inbox retires without delivery', () => {
    expect(() => managerInboxTurnEvent(directory, { ...common, kind: 'patrol' })).toThrow();
  });
  it.each([true, false])('maps completion success=%s without changing the saved result', (success) => {
    const saved = { ...common, kind: 'completion' as const, taskName: 'validation', runSlug: 'run-validation',
      result: { success, interrupted: !success, workflowResult: success ? 'completed' as const : 'aborted' as const,
        ...(success ? {} : { failureReason: `Goal ${common.goalId} was paused` }) } };
    const original = structuredClone(saved);
    expect(managerInboxTurnEvent(directory, saved)).toEqual({
      kind: success ? 'task_completed' : 'task_failed',
      task: { repositoryDirectory: directory, goalId: common.goalId, taskName: saved.taskName, runSlug: saved.runSlug },
      result: saved.result,
    });
    expect(saved).toEqual(original);
  });

  it.each([undefined, 'setup-650e8400-e29b-41d4-a716-446655440001'])('preserves an optional setup identity: %s', (runSlug) => {
    const saved: Extract<ManagerEvent, { kind: 'completion' }> = { ...common, kind: 'completion', taskName: 'report',
      ...(runSlug === undefined ? {} : { runSlug }), result: { success: false, interrupted: true,
        workflowResult: 'error', failureReason: `Goal ${common.goalId} was paused` } };
    const event = managerInboxTurnEvent(directory, saved);
    expect(event).toEqual({ kind: 'task_failed', task: { repositoryDirectory: directory,
      goalId: common.goalId, taskName: 'report', ...(runSlug === undefined ? {} : { runSlug }) }, result: saved.result });
  });

  it('maps a saved answer with its structured decision', () => {
    const answer = { text: 'Continue', answeredAt: common.createdAt, decision: 'allow' as const, source: 'tui' as const, scope: 'once' as const };
    const saved = { ...common, kind: 'answer' as const, questionId: '650e8400-e29b-41d4-a716-446655440002', answer };
    expect(managerInboxTurnEvent(directory, saved)).toEqual({ kind: 'inquiry_answered', repositoryDirectory: directory,
      goalId: common.goalId, questionId: saved.questionId, answer });
  });

  it.each([['registered', 'goal_registered'], ['resumed', 'goal_resumed']] as const)('maps %s to %s', (kind, expected) => {
    const event = managerInboxTurnEvent(directory, { ...common, kind });
    expect(event).toEqual({
      kind: expected, repositoryDirectory: directory, goalId: common.goalId,
    });
    const promptEvent = kind === 'resumed' ? { ...event, origin: 'unknown' } : event;
    expect(JSON.parse(buildManagerEventPrompt(event))).toEqual({ event: promptEvent, instruction: expect.any(String) });
  });
});

describe('buildManagerEventPrompt', () => {
  it('delivers readable and unreadable patrol goals with the turn instruction', () => {
    const event = { kind: 'patrol' as const, repositoryDirectory: directory,
      goalIds: [common.goalId], unreadableGoalIds: ['650e8400-e29b-41d4-a716-446655440099'] };
    const prompt = JSON.parse(buildManagerEventPrompt(event));
    expect(prompt).toEqual({ event, instruction: expect.any(String) });
    expect(prompt.instruction.trim().length).toBeGreaterThan(0);
  });
});
