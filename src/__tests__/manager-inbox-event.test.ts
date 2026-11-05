import { describe, expect, it } from 'vitest';
import { managerInboxTurnEvent } from '../features/daemon/inboxEvent.js';
import type { ManagerEvent } from '../infra/goals/events.js';

const common = { goalId: '650e8400-e29b-41d4-a716-446655440000', createdAt: '2026-11-01T00:00:00.000Z' };
const directory = '/workspace/project';

describe('managerInboxTurnEvent', () => {
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
    expect(managerInboxTurnEvent(directory, { ...common, kind })).toEqual({
      kind: expected, repositoryDirectory: directory, goalId: common.goalId,
    });
  });
});
