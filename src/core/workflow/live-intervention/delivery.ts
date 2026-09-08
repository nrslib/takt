import type { PermissionMode } from '../../models/types.js';
import type {
  LiveInterventionChannel,
  LiveInterventionState,
  PreparedLiveInterventionDelivery,
} from './types.js';

export interface LiveInterventionDeliveryCommitter {
  readonly onDispatch: (permissionMode: PermissionMode | undefined) => void;
  settle(): Promise<void>;
}

/**
 * Couples one prepared delivery to the provider dispatch boundary.
 * A provider failure after dispatch still settles the delivery, while a failure
 * before the callback leaves the IDs pending in the canonical channel.
 */
export function createLiveInterventionDeliveryCommitter(
  channel: LiveInterventionChannel | undefined,
  delivery: PreparedLiveInterventionDelivery | undefined,
  priorOnDispatch?: (permissionMode: PermissionMode | undefined) => void,
): LiveInterventionDeliveryCommitter | undefined {
  if (channel === undefined || delivery === undefined) {
    return undefined;
  }

  let dispatched = false;
  let commitPromise: Promise<void> | undefined;
  return {
    onDispatch(permissionMode): void {
      priorOnDispatch?.(permissionMode);
      if (dispatched) {
        return;
      }
      dispatched = true;
      commitPromise = channel.commitDelivery(delivery);
    },
    async settle(): Promise<void> {
      await commitPromise;
    },
  };
}

/**
 * Gives an isolated workflow_call the parent delivery without giving it
 * ownership of the canonical instruction ledger.
 */
export function createScopedLiveInterventionChannel(
  parent: LiveInterventionChannel,
  delivery: PreparedLiveInterventionDelivery,
  parentCommitter: LiveInterventionDeliveryCommitter,
): LiveInterventionChannel {
  const deliveryIds = new Set(delivery.instructionIds);
  let dispatched = false;

  const readScopedState = (): LiveInterventionState => {
    const parentState = parent.read();
    const instructions = parentState.instructions
      .filter((instruction) => deliveryIds.has(instruction.instructionId))
      .map((instruction) => dispatched
        ? instruction
        : { ...instruction, state: 'pending' as const });
    const pending = dispatched
      ? 0
      : instructions.filter((instruction) => instruction.state === 'pending').length;
    return {
      ...parentState,
      instructions,
      pending,
      issuedTotal: instructions.length,
      deliveredSameSession: instructions.filter((instruction) => instruction.state === 'deliveredSameSession').length,
      deliveredNextStep: instructions.filter((instruction) => instruction.state === 'deliveredNextStep').length,
      unconsumedWarned: instructions.filter((instruction) => instruction.state === 'unconsumedWarned').length,
      warned: instructions.some((instruction) => instruction.state === 'unconsumedWarned'),
    };
  };

  return {
    read: readScopedState,
    prepareDelivery: async () => delivery,
    commitDelivery: async () => {
      if (!dispatched) {
        dispatched = true;
        parentCommitter.onDispatch(undefined);
      }
      await parentCommitter.settle();
    },
    recordTerminal: async () => 0,
  };
}
