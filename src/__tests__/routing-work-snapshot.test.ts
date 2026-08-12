import { describe, expect, it } from 'vitest';
import { createRoutingWorkFingerprint, normalizeRoutingWorkSnapshot } from '../core/workflow/auto-routing/normalizer.js';
import { ROUTING_WORK_SNAPSHOT_LOCAL_IDENTITY } from '../core/workflow/auto-routing/contracts.js';
import { buildRoutingWorkSnapshot } from '../core/workflow/auto-routing/snapshot.js';

describe('buildRoutingWorkSnapshot', () => {
  it('projects task, team part, and prior output without exposing unrelated fields', () => {
    const snapshot = buildRoutingWorkSnapshot({
      goal: 'Implement the requested feature',
      userInputs: ['Focus on the failing integration path'],
      step: {
        name: 'implement',
        tags: ['implementation'],
        personaKey: 'coder',
        instruction: 'Apply the requested change',
        stepType: 'agent',
        edit: true,
        passPreviousResponse: true,
      },
      part: {
        title: 'Fix the request validator',
        instruction: 'Update validation and its tests',
      },
      lastOutput: 'The validation branch remains incomplete.',
    });

    expect(snapshot).toStrictEqual({
      goal: 'Implement the requested feature',
      step: {
        name: 'implement',
        tags: ['implementation'],
        personaKey: 'coder',
        instruction: 'Apply the requested change',
        stepType: 'agent',
        edit: true,
      },
      remainingWork: [
        { source: 'task', description: 'Focus on the failing integration path' },
        {
          source: 'team-part',
          title: 'Fix the request validator',
          description: 'Update validation and its tests',
        },
        { source: 'prior-result', description: 'The validation branch remains incomplete.' },
      ],
      progress: {
        previousAttemptFailed: false,
        noProgress: false,
        retryingSameWork: false,
      },
    });
  });

  it('does not project prior output when the step does not receive it', () => {
    const snapshot = buildRoutingWorkSnapshot({
      goal: 'Review a change',
      userInputs: [],
      step: {
        name: 'review',
        tags: [],
        stepType: 'normal',
        edit: false,
        passPreviousResponse: false,
      },
      lastOutput: 'This output belongs to a previous step.',
    });

    expect(snapshot.remainingWork).toStrictEqual([]);
  });

  it('does not expose iteration values in otherwise identical snapshots', () => {
    const input = {
      goal: 'Apply a focused follow-up change',
      userInputs: ['Update the validation branch'],
      step: {
        name: 'implement',
        tags: ['implementation'],
        stepType: 'normal' as const,
        edit: true,
        passPreviousResponse: false,
      },
    };

    expect(buildRoutingWorkSnapshot(input)).toStrictEqual(buildRoutingWorkSnapshot(input));
  });

  it('keeps the bounded projection stable but changes the full-work fingerprint when omitted task text changes', () => {
    const createSnapshot = (tail: string) => buildRoutingWorkSnapshot({
      goal: 'Complete all requested work',
      userInputs: Array.from({ length: 100 }, (_, index) => (
        index === 99 ? tail : `task-${index}`
      )),
      step: { name: 'implement', tags: [], stepType: 'normal', passPreviousResponse: false },
    });
    const first = createSnapshot('tail-a');
    const replacement = createSnapshot('tail-b');

    expect(first.remainingWork).toHaveLength(64);
    expect(normalizeRoutingWorkSnapshot(first).remainingWorkOmittedCount).toBe(36);
    expect(replacement.remainingWork).toEqual(first.remainingWork);
    expect(createRoutingWorkFingerprint(replacement)).not.toBe(createRoutingWorkFingerprint(first));
  });

  it('keeps snapshots and their local identity immutable', () => {
    const snapshot = buildRoutingWorkSnapshot({
      goal: 'Complete the task',
      userInputs: ['Before.'],
      step: { name: 'implement', tags: [], stepType: 'normal', passPreviousResponse: false },
    });
    const fingerprint = createRoutingWorkFingerprint(snapshot);
    const localIdentity = snapshot[ROUTING_WORK_SNAPSHOT_LOCAL_IDENTITY];

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.step)).toBe(true);
    expect(Object.isFrozen(snapshot.step.tags)).toBe(true);
    expect(Object.isFrozen(snapshot.remainingWork)).toBe(true);
    expect(Object.isFrozen(snapshot.remainingWork[0])).toBe(true);
    expect(Object.isFrozen(localIdentity)).toBe(true);
    expect(() => {
      (snapshot.remainingWork[0] as { description: string }).description = 'After.';
    }).toThrow();
    expect(normalizeRoutingWorkSnapshot(snapshot).remainingWork[0]?.description).toBe('Before.');
    expect(createRoutingWorkFingerprint(snapshot)).toBe(fingerprint);
  });
});
