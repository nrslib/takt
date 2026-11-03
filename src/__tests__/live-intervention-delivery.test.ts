import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { createLiveInterventionDeliveryCommitter, createScopedLiveInterventionChannel } from '../core/workflow/live-intervention/delivery.js';
import { createLiveInterventionState, reduceLiveInterventionEvent } from '../core/workflow/live-intervention/state.js';
import { buildLiveInterventionPrompt } from '../core/workflow/live-intervention/prompt.js';
import type { LiveInterventionChannel, PreparedLiveInterventionDelivery } from '../core/workflow/live-intervention/types.js';

describe('live intervention delivery settlement', () => {
  it('provides delivered history without a current delivery and cannot consume new parent instructions', async () => {
    const parent: LiveInterventionChannel = {
      read: () => ({
        ...createLiveInterventionState(), issuedTotal: 2, pending: 1, deliveredNextStep: 1,
        instructions: [
          { instructionId: 1, issuedAt: '2026-10-29T00:00:00.000Z', content: 'docs は変えない', state: 'deliveredNextStep' },
          { instructionId: 2, issuedAt: '2026-10-29T00:00:01.000Z', content: 'later instruction', state: 'pending' },
        ],
      }),
      prepareDelivery: vi.fn(), commitDelivery: vi.fn(), recordTerminal: vi.fn(),
    };
    const child = createScopedLiveInterventionChannel(parent, undefined, undefined);

    expect(child.read()).toMatchObject({
      pending: 0, issuedTotal: 1, deliveredNextStep: 1,
      instructions: [{ instructionId: 1, state: 'deliveredNextStep' }],
    });
    await expect(child.prepareDelivery({ mode: 'next_step', step: 'adjudicate', phase: 1 })).rejects.toThrow();
    await expect(child.recordTerminal('completed')).resolves.toBe(0);
    expect(parent.read().instructions[1]).toMatchObject({ instructionId: 2, state: 'pending' });
    expect(parent.prepareDelivery).not.toHaveBeenCalled();
    expect(parent.commitDelivery).not.toHaveBeenCalled();
    expect(parent.recordTerminal).not.toHaveBeenCalled();
  });

  it('exposes delivered history to a child while keeping unrelated pending instructions and delivery ownership in the parent', async () => {
    let state = reduceLiveInterventionEvent(createLiveInterventionState(), {
      type: 'issued', instructionId: 1, issuedAt: '2026-10-29T00:00:00.000Z', content: 'docs は変えない',
    });
    state = reduceLiveInterventionEvent(state, {
      type: 'delivered', instructionIds: [1], deliveredAt: '2026-10-29T00:00:01.000Z',
      mode: 'same_session', step: 'implement', phase: 1,
    });
    state = reduceLiveInterventionEvent(state, {
      type: 'issued', instructionId: 2, issuedAt: '2026-10-29T00:00:02.000Z', content: 'run the focused tests',
    });
    const delivery: PreparedLiveInterventionDelivery = {
      instructionIds: [2], prompt: buildLiveInterventionPrompt(state.instructions, 'ja'),
      context: { mode: 'next_step', step: 'reviewers', phase: 1 },
    };
    const parent: LiveInterventionChannel = {
      read: () => state,
      prepareDelivery: vi.fn().mockResolvedValue(delivery),
      commitDelivery: vi.fn().mockImplementation(async () => {
        state = reduceLiveInterventionEvent(state, {
          type: 'delivered', instructionIds: [2], deliveredAt: '2026-10-29T00:00:03.000Z',
          ...delivery.context,
        });
      }),
      recordTerminal: vi.fn().mockResolvedValue(0),
    };
    const committer = createLiveInterventionDeliveryCommitter(parent, delivery)!;
    const child = createScopedLiveInterventionChannel(parent, delivery, committer);
    state = reduceLiveInterventionEvent(state, {
      type: 'issued', instructionId: 3, issuedAt: '2026-10-29T00:00:04.000Z', content: 'later parent instruction',
    });

    const beforeDispatch = child.read();
    expect.soft(beforeDispatch.instructions.map(({ instructionId, state: instructionState }) => [instructionId, instructionState]))
      .toEqual([[1, 'deliveredSameSession'], [2, 'pending']]);
    expect(beforeDispatch.pending).toBe(1);
    expect(parent.commitDelivery).not.toHaveBeenCalled();
    const prepared = await child.prepareDelivery({ mode: 'next_step', step: 'adjudicate', phase: 1 });
    expect(prepared.instructionIds).toEqual([2]);
    for (const content of ['docs は変えない', 'run the focused tests']) {
      expect(prepared.prompt.split(content)).toHaveLength(2);
    }
    await child.commitDelivery(prepared);
    await child.commitDelivery(prepared);
    const afterDispatch = child.read();

    expect.soft(afterDispatch.instructions.map(({ instructionId, state: instructionState }) => [instructionId, instructionState]))
      .toEqual([[1, 'deliveredSameSession'], [2, 'deliveredNextStep']]);
    expect(afterDispatch.pending).toBe(0);
    expect(parent.commitDelivery).toHaveBeenCalledExactlyOnceWith(delivery);
    expect(parent.prepareDelivery).not.toHaveBeenCalled();
    expect(state.instructions[2]).toMatchObject({ instructionId: 3, state: 'pending' });
    await expect(child.recordTerminal('completed')).resolves.toBe(0);
    expect(parent.recordTerminal).not.toHaveBeenCalled();
  });

  it.each([new Error('ledger write failed'), undefined])(
    'observes a dispatch rejection before provider completion and propagates it at settlement (%s)',
    async (failure) => {
      const delivery: PreparedLiveInterventionDelivery = {
        instructionIds: [1],
        prompt: 'additional instruction',
        context: { mode: 'same_session', step: 'implement', phase: 1 },
      };
      const channel: LiveInterventionChannel = {
        read: createLiveInterventionState,
        prepareDelivery: async () => delivery,
        commitDelivery: vi.fn().mockRejectedValue(failure),
        recordTerminal: async () => 0,
      };
      const committer = createLiveInterventionDeliveryCommitter(channel, delivery)!;

      committer.onDispatch(undefined);
      // A real event-loop turn exposes unhandled rejections while the provider is still active.
      await setImmediate();

      await expect(committer.settle()).rejects.toBe(failure);
      committer.onDispatch(undefined);
      await expect(committer.settle()).rejects.toBe(failure);
      expect(channel.commitDelivery).toHaveBeenCalledExactlyOnceWith(delivery);
    },
  );
});
