import { describe, expect, it } from 'vitest';
import {
  createLiveInterventionState,
  reduceLiveInterventionEvent,
} from '../core/workflow/live-intervention/state.js';
import type {
  LiveInterventionEvent,
  LiveInterventionState,
} from '../core/workflow/live-intervention/types.js';
import { buildLiveInterventionPrompt } from '../core/workflow/live-intervention/prompt.js';

const FIRST_ISSUED_AT = '2026-09-03T00:00:00.000Z';
const SECOND_ISSUED_AT = '2026-09-03T00:00:01.000Z';

function issue(
  state: LiveInterventionState,
  instructionId: number,
  content: string,
  issuedAt: string,
): LiveInterventionState {
  const event: LiveInterventionEvent = {
    type: 'issued',
    instructionId,
    issuedAt,
    content,
  };
  return reduceLiveInterventionEvent(state, event);
}

describe('live intervention state', () => {
  it('keeps opaque issued bodies in order and frames the complete history for delivery', () => {
    const afterFirst = issue(
      createLiveInterventionState(),
      1,
      'Aを追加して',
      FIRST_ISSUED_AT,
    );
    const state = issue(
      afterFirst,
      2,
      'さっきのAはやっぱりなし',
      SECOND_ISSUED_AT,
    );

    expect(state.instructions).toEqual([
      expect.objectContaining({
        instructionId: 1,
        issuedAt: FIRST_ISSUED_AT,
        content: 'Aを追加して',
        state: 'pending',
      }),
      expect.objectContaining({
        instructionId: 2,
        issuedAt: SECOND_ISSUED_AT,
        content: 'さっきのAはやっぱりなし',
        state: 'pending',
      }),
    ]);
    expect(state.pending).toBe(2);
    expect(state.issuedTotal).toBe(2);
    expect(buildLiveInterventionPrompt(state.instructions)).toEqual(expect.stringContaining('Aを追加して'));

    const prompt = buildLiveInterventionPrompt(state.instructions);
    expect(prompt.indexOf('Aを追加して')).toBeLessThan(prompt.indexOf('さっきのAはやっぱりなし'));
    expect(prompt).toContain('ユーザー');
  });

  it('moves every pending instruction to the selected delivery state as one batch', () => {
    let state = createLiveInterventionState();
    state = issue(state, 1, 'one', FIRST_ISSUED_AT);
    state = issue(state, 2, 'two', SECOND_ISSUED_AT);

    state = reduceLiveInterventionEvent(state, {
      type: 'delivered',
      instructionIds: [1, 2],
      deliveredAt: '2026-09-03T00:00:02.000Z',
      mode: 'same_session',
      step: 'implement',
      phase: 1,
    });

    expect(state.instructions.every((instruction) => instruction.state === 'deliveredSameSession')).toBe(true);
    expect(state.pending).toBe(0);
    expect(state.deliveredSameSession).toBe(2);
    expect(state.deliveredNextStep).toBe(0);
    expect(state.unconsumedWarned).toBe(0);
    expect(state.issuedTotal).toBe(
      state.pending
      + state.deliveredSameSession
      + state.deliveredNextStep
      + state.unconsumedWarned,
    );
  });

  it.each([
    ['next_step', 'deliveredNextStep'],
    ['batch_boundary', 'deliveredNextStep'],
  ] as const)('accounts for %s delivery without changing the issued bodies', (mode, expectedState) => {
    let state = createLiveInterventionState();
    state = issue(state, 1, 'keep this body unchanged', FIRST_ISSUED_AT);

    state = reduceLiveInterventionEvent(state, {
      type: 'delivered',
      instructionIds: [1],
      deliveredAt: '2026-09-03T00:00:02.000Z',
      mode,
      step: 'review',
      phase: 2,
      ...(mode === 'batch_boundary'
        ? {
            processedBatchCount: 2,
            runningBatchIndexes: [2, 3],
            appliesToBatchIndexes: [4, 5],
          }
        : {}),
    });

    expect(state.instructions[0]).toMatchObject({
      instructionId: 1,
      content: 'keep this body unchanged',
      state: expectedState,
    });
    expect(state.pending).toBe(0);
    expect(state.deliveredSameSession).toBe(0);
    expect(state.deliveredNextStep).toBe(1);
  });

  it.each(['completed', 'failed'] as const)('records terminal pending instructions as warned without deleting history (%s)', (status) => {
    let state = createLiveInterventionState();
    state = issue(state, 1, 'first', FIRST_ISSUED_AT);
    state = issue(state, 2, 'second', SECOND_ISSUED_AT);

    state = reduceLiveInterventionEvent(state, {
      type: 'terminal',
      terminalAt: '2026-09-03T00:00:03.000Z',
      status,
      unconsumedInstructionIds: [1, 2],
    });

    expect(state.instructions).toEqual([
      expect.objectContaining({ instructionId: 1, content: 'first', state: 'unconsumedWarned' }),
      expect.objectContaining({ instructionId: 2, content: 'second', state: 'unconsumedWarned' }),
    ]);
    expect(state.pending).toBe(0);
    expect(state.unconsumedWarned).toBe(2);
    expect(state.warned).toBe(true);
    expect(state.issuedTotal).toBe(2);
    expect(state.terminalStatus).toBe(status);
  });

  it('rejects delivery of a non-pending or unknown instruction and preserves the prior state', () => {
    let state = createLiveInterventionState();
    state = issue(state, 1, 'one', FIRST_ISSUED_AT);
    state = reduceLiveInterventionEvent(state, {
      type: 'delivered',
      instructionIds: [1],
      deliveredAt: '2026-09-03T00:00:02.000Z',
      mode: 'same_session',
      step: 'implement',
      phase: 1,
    });

    expect(() => reduceLiveInterventionEvent(state, {
      type: 'delivered',
      instructionIds: [1],
      deliveredAt: '2026-09-03T00:00:03.000Z',
      mode: 'same_session',
      step: 'implement',
      phase: 1,
    })).toThrow(/pending|delivered|state/i);
    expect(() => reduceLiveInterventionEvent(state, {
      type: 'delivered',
      instructionIds: [99],
      deliveredAt: '2026-09-03T00:00:03.000Z',
      mode: 'same_session',
      step: 'implement',
      phase: 1,
    })).toThrow(/unknown|instruction|issued/i);
  });

  it('rejects issuing after terminal state instead of reopening the run', () => {
    let state = createLiveInterventionState();
    state = reduceLiveInterventionEvent(state, {
      type: 'terminal',
      terminalAt: '2026-09-03T00:00:00.000Z',
      status: 'completed',
      unconsumedInstructionIds: [],
    });

    expect(() => issue(state, 1, 'late', '2026-09-03T00:00:01.000Z')).toThrow(/terminal|finished|completed/i);
  });
});
