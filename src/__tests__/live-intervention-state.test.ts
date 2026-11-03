import { describe, expect, it, vi } from 'vitest';
import {
  createLiveInterventionState,
  reduceLiveInterventionEvent,
} from '../core/workflow/live-intervention/state.js';
import type {
  LiveInterventionChannel,
  LiveInterventionState,
} from '../core/workflow/live-intervention/types.js';
import type { LiveInterventionEvent } from '../core/workflow/live-intervention/state.js';
import { buildLiveInterventionPrompt, resolveLiveInterventionPrompt } from '../core/workflow/live-intervention/prompt.js';

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
  it('selects only delivered history in issue order without changing delivery state', () => {
    const state: LiveInterventionState = {
      ...createLiveInterventionState(),
      issuedTotal: 4, pending: 1, deliveredSameSession: 1, deliveredNextStep: 1,
      unconsumedWarned: 1, warned: true,
      instructions: [
        { instructionId: 1, issuedAt: FIRST_ISSUED_AT, content: 'docs は変えない', state: 'deliveredSameSession' },
        { instructionId: 2, issuedAt: SECOND_ISSUED_AT, content: 'pending instruction', state: 'pending' },
        { instructionId: 3, issuedAt: SECOND_ISSUED_AT, content: 'focused tests only', state: 'deliveredNextStep' },
        { instructionId: 4, issuedAt: SECOND_ISSUED_AT, content: 'warned instruction', state: 'unconsumedWarned' },
      ],
    };
    const before = structuredClone(state);
    const channel: LiveInterventionChannel = {
      read: () => state, prepareDelivery: vi.fn(), commitDelivery: vi.fn(), recordTerminal: vi.fn(),
    };

    const prompt = resolveLiveInterventionPrompt(channel, undefined, 'ja');

    expect(prompt.split('docs は変えない')).toHaveLength(2);
    expect(prompt.split('focused tests only')).toHaveLength(2);
    expect(prompt.indexOf('docs は変えない')).toBeLessThan(prompt.indexOf('focused tests only'));
    expect(prompt).not.toContain('pending instruction');
    expect(prompt).not.toContain('warned instruction');
    expect(state).toEqual(before);
    expect(channel.prepareDelivery).not.toHaveBeenCalled();
    expect(channel.commitDelivery).not.toHaveBeenCalled();
    expect(channel.recordTerminal).not.toHaveBeenCalled();
  });

  it('uses the complete prepared delivery once without adding delivered history again', () => {
    const channel: LiveInterventionChannel = {
      read: vi.fn(), prepareDelivery: vi.fn(), commitDelivery: vi.fn(), recordTerminal: vi.fn(),
    };
    const delivery = {
      instructionIds: [2], prompt: 'docs は変えない\nfocused tests only',
      context: { mode: 'next_step' as const, step: 'review', phase: 1 as const },
    };

    expect(resolveLiveInterventionPrompt(channel, delivery, 'ja')).toBe(delivery.prompt);
    expect(channel.read).not.toHaveBeenCalled();
  });

  it('produces no additional prompt without a channel or delivered history', () => {
    const channel: LiveInterventionChannel = {
      read: createLiveInterventionState, prepareDelivery: vi.fn(), commitDelivery: vi.fn(), recordTerminal: vi.fn(),
    };
    expect(resolveLiveInterventionPrompt(undefined, undefined, 'ja')).toBe('');
    expect(resolveLiveInterventionPrompt(channel, undefined, 'ja')).toBe('');
  });

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
    expect(buildLiveInterventionPrompt(state.instructions, 'ja')).toEqual(expect.stringContaining('Aを追加して'));

    const prompt = buildLiveInterventionPrompt(state.instructions, 'ja');
    expect(prompt.indexOf('Aを追加して')).toBeLessThan(prompt.indexOf('さっきのAはやっぱりなし'));
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

  it.each([
    { name: 'non-pending', instructionId: 1 },
    { name: 'unknown', instructionId: 99 },
  ])('rejects delivery of a $name instruction and preserves the prior state', ({ instructionId }) => {
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

    const priorState = structuredClone(state);
    expect(() => reduceLiveInterventionEvent(state, {
      type: 'delivered',
      instructionIds: [instructionId],
      deliveredAt: '2026-09-03T00:00:03.000Z',
      mode: 'same_session',
      step: 'implement',
      phase: 1,
    })).toThrow();
    expect(state).toEqual(priorState);
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
