import type { Language } from '../../models/types.js';

export type LiveInterventionInstructionState =
  | 'pending'
  | 'deliveredSameSession'
  | 'deliveredNextStep'
  | 'unconsumedWarned';

export type LiveInterventionDeliveryMode =
  | 'same_session'
  | 'next_step'
  | 'batch_boundary';

export interface LiveInterventionInstruction {
  readonly instructionId: number;
  readonly issuedAt: string;
  readonly content: string;
  readonly state: LiveInterventionInstructionState;
  readonly deliveryMode?: LiveInterventionDeliveryMode;
}

export interface LiveInterventionDelivery {
  readonly mode: LiveInterventionDeliveryMode;
  readonly step: string;
  readonly phase: 1 | 2 | 3;
  readonly target?: string;
  readonly processedBatchCount?: number;
  readonly runningBatchIndexes?: readonly number[];
  readonly appliesToBatchIndexes?: readonly number[];
}

export interface LiveInterventionState {
  readonly instructions: readonly LiveInterventionInstruction[];
  readonly pending: number;
  readonly issuedTotal: number;
  readonly deliveredSameSession: number;
  readonly deliveredNextStep: number;
  readonly unconsumedWarned: number;
  readonly warned: boolean;
  readonly terminalStatus?: 'completed' | 'failed';
  readonly lastDelivery?: LiveInterventionDelivery;
}

export interface LiveInterventionDeliveryContext extends LiveInterventionDelivery {
  readonly language?: Language;
}

export interface PreparedLiveInterventionDelivery {
  readonly instructionIds: readonly number[];
  readonly prompt: string;
  readonly context: LiveInterventionDeliveryContext;
}

export interface LiveInterventionChannel {
  read(): LiveInterventionState;
  prepareDelivery(context: LiveInterventionDeliveryContext): Promise<PreparedLiveInterventionDelivery>;
  commitDelivery(delivery: PreparedLiveInterventionDelivery): Promise<void>;
  recordTerminal(status: 'completed' | 'failed', terminalAt?: string): Promise<number>;
}
