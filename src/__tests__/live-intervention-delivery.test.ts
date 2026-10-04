import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { createLiveInterventionDeliveryCommitter } from '../core/workflow/live-intervention/delivery.js';
import { createLiveInterventionState } from '../core/workflow/live-intervention/state.js';
import type { LiveInterventionChannel, PreparedLiveInterventionDelivery } from '../core/workflow/live-intervention/types.js';

describe('live intervention delivery settlement', () => {
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
