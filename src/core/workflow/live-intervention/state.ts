import type {
  LiveInterventionInstruction,
  LiveInterventionState,
} from './types.js';

export type LiveInterventionEvent =
  | {
      readonly type: 'issued';
      readonly instructionId: number;
      readonly issuedAt: string;
      readonly content: string;
    }
  | {
      readonly type: 'delivered';
      readonly instructionIds: readonly number[];
      readonly deliveredAt: string;
      readonly mode: 'same_session' | 'next_step' | 'batch_boundary';
      readonly step: string;
      readonly phase: 1 | 2 | 3;
      readonly target?: string;
      readonly processedBatchCount?: number;
      readonly runningBatchIndexes?: readonly number[];
      readonly appliesToBatchIndexes?: readonly number[];
    }
  | {
      readonly type: 'terminal';
      readonly terminalAt: string;
      readonly status: 'completed' | 'failed';
      readonly unconsumedInstructionIds: readonly number[];
    };

const INITIAL_STATE: LiveInterventionState = Object.freeze({
  instructions: [],
  pending: 0,
  issuedTotal: 0,
  deliveredSameSession: 0,
  deliveredNextStep: 0,
  unconsumedWarned: 0,
  warned: false,
});

function cloneState(state: LiveInterventionState): LiveInterventionState {
  return {
    ...state,
    instructions: state.instructions.map((instruction) => ({ ...instruction })),
    ...(state.lastDelivery === undefined
      ? {}
      : {
          lastDelivery: {
            ...state.lastDelivery,
            ...(state.lastDelivery.runningBatchIndexes === undefined
              ? {}
              : { runningBatchIndexes: [...state.lastDelivery.runningBatchIndexes] }),
            ...(state.lastDelivery.appliesToBatchIndexes === undefined
              ? {}
              : { appliesToBatchIndexes: [...state.lastDelivery.appliesToBatchIndexes] }),
          },
        }),
  };
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function requireUniquePositiveIntegers(
  values: readonly number[],
  name: string,
  allowEmpty = false,
): void {
  if (values.length === 0 && !allowEmpty) {
    throw new Error(`${name} must not be empty`);
  }
  const unique = new Set<number>();
  for (const value of values) {
    requirePositiveInteger(value, `${name} entry`);
    if (unique.has(value)) {
      throw new Error(`${name} must not contain duplicate IDs`);
    }
    unique.add(value);
  }
}

function assertDeliveryMetadata(event: Extract<LiveInterventionEvent, { type: 'delivered' }>): void {
  requireNonEmptyString(event.deliveredAt, 'deliveredAt');
  if (event.mode !== 'same_session' && event.mode !== 'next_step' && event.mode !== 'batch_boundary') {
    throw new Error('delivery mode is invalid');
  }
  requireNonEmptyString(event.step, 'step');
  if (event.phase !== 1 && event.phase !== 2 && event.phase !== 3) {
    throw new Error('phase must be 1, 2, or 3');
  }
  if (event.target !== undefined) {
    requireNonEmptyString(event.target, 'target');
  }
  if (event.processedBatchCount !== undefined) {
    requireNonNegativeInteger(event.processedBatchCount, 'processedBatchCount');
  }
  for (const [name, indexes] of [
    ['runningBatchIndexes', event.runningBatchIndexes],
    ['appliesToBatchIndexes', event.appliesToBatchIndexes],
  ] as const) {
    if (indexes !== undefined) {
      for (const index of indexes) {
        requireNonNegativeInteger(index, `${name} entry`);
      }
      if (new Set(indexes).size !== indexes.length) {
        throw new Error(`${name} must not contain duplicate indexes`);
      }
    }
  }
}

function assertStateCounts(state: LiveInterventionState): void {
  const pending = state.instructions.filter((instruction) => instruction.state === 'pending').length;
  const sameSession = state.instructions.filter((instruction) => instruction.state === 'deliveredSameSession').length;
  const nextStep = state.instructions.filter((instruction) => instruction.state === 'deliveredNextStep').length;
  const warned = state.instructions.filter((instruction) => instruction.state === 'unconsumedWarned').length;
  if (
    pending !== state.pending
    || sameSession !== state.deliveredSameSession
    || nextStep !== state.deliveredNextStep
    || warned !== state.unconsumedWarned
    || state.issuedTotal !== state.instructions.length
  ) {
    throw new Error('Live intervention state counts are inconsistent');
  }
  if (state.warned !== (warned > 0)) {
    throw new Error('Live intervention warning state is inconsistent');
  }
}

export function createLiveInterventionState(): LiveInterventionState {
  return cloneState(INITIAL_STATE);
}

export function reduceLiveInterventionEvent(
  current: LiveInterventionState,
  event: LiveInterventionEvent,
): LiveInterventionState {
  const state = cloneState(current);
  const instructions = [...state.instructions];

  switch (event.type) {
    case 'issued': {
      const instructionId = requirePositiveInteger(event.instructionId, 'instructionId');
      requireNonEmptyString(event.issuedAt, 'issuedAt');
      if (typeof event.content !== 'string') {
        throw new Error('content must be a string');
      }
      if (state.terminalStatus !== undefined) {
        throw new Error('Cannot issue an instruction after terminal state');
      }
      if (instructions.some((instruction) => instruction.instructionId === instructionId)) {
        throw new Error(`Duplicate instruction ID: ${instructionId}`);
      }
      const expectedId = state.issuedTotal + 1;
      if (instructionId !== expectedId) {
        throw new Error(`Instruction ID must increase from ${expectedId}`);
      }
      instructions.push({
        instructionId,
        issuedAt: event.issuedAt,
        content: event.content,
        state: 'pending',
      });
      return {
        ...state,
        instructions,
        pending: state.pending + 1,
        issuedTotal: state.issuedTotal + 1,
      };
    }
    case 'delivered': {
      requireUniquePositiveIntegers(event.instructionIds, 'instructionIds');
      assertDeliveryMetadata(event);
      if (state.terminalStatus !== undefined) {
        throw new Error('Cannot deliver instructions after terminal state');
      }
      const ids = new Set(event.instructionIds);
      const selected = instructions.filter((instruction) => ids.has(instruction.instructionId));
      if (selected.length !== ids.size) {
        throw new Error('Delivery references an unknown instruction ID');
      }
      if (selected.some((instruction) => instruction.state !== 'pending')) {
        throw new Error('Delivery references a non-pending instruction');
      }
      const deliveryState: LiveInterventionInstruction['state'] = event.mode === 'same_session'
        ? 'deliveredSameSession'
        : 'deliveredNextStep';
      const updatedInstructions = instructions.map((instruction) => ids.has(instruction.instructionId)
        ? { ...instruction, state: deliveryState, deliveryMode: event.mode }
        : instruction);
      const lastDelivery = {
        mode: event.mode,
        step: event.step,
        phase: event.phase,
        ...(event.target === undefined ? {} : { target: event.target }),
        ...(event.processedBatchCount === undefined ? {} : { processedBatchCount: event.processedBatchCount }),
        ...(event.runningBatchIndexes === undefined ? {} : { runningBatchIndexes: [...event.runningBatchIndexes] }),
        ...(event.appliesToBatchIndexes === undefined ? {} : { appliesToBatchIndexes: [...event.appliesToBatchIndexes] }),
      } satisfies LiveInterventionState['lastDelivery'];
      const next = {
        ...state,
        instructions: updatedInstructions,
        pending: state.pending - ids.size,
        ...(event.mode === 'same_session'
          ? { deliveredSameSession: state.deliveredSameSession + ids.size }
          : { deliveredNextStep: state.deliveredNextStep + ids.size }),
        lastDelivery,
      };
      assertStateCounts(next);
      return next;
    }
    case 'terminal': {
      requireNonEmptyString(event.terminalAt, 'terminalAt');
      if (event.status !== 'completed' && event.status !== 'failed') {
        throw new Error('Terminal status is invalid');
      }
      if (state.terminalStatus !== undefined) {
        throw new Error('Live intervention terminal state is already recorded');
      }
      const pendingIds = instructions
        .filter((instruction) => instruction.state === 'pending')
        .map((instruction) => instruction.instructionId);
      requireUniquePositiveIntegers(event.unconsumedInstructionIds, 'unconsumedInstructionIds', true);
      if (
        event.unconsumedInstructionIds.length !== pendingIds.length
        || event.unconsumedInstructionIds.some((id, index) => id !== pendingIds[index])
      ) {
        throw new Error('Terminal event must list all pending instruction IDs in order');
      }
      const pendingSet = new Set(event.unconsumedInstructionIds);
      const updatedInstructions = instructions.map((instruction) => pendingSet.has(instruction.instructionId)
        ? { ...instruction, state: 'unconsumedWarned' as const }
        : instruction);
      const next = {
        ...state,
        instructions: updatedInstructions,
        pending: 0,
        unconsumedWarned: state.unconsumedWarned + pendingSet.size,
        warned: pendingSet.size > 0 || state.warned,
        terminalStatus: event.status,
      };
      assertStateCounts(next);
      return next;
    }
  }
}
