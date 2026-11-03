import { randomUUID } from 'node:crypto';
import type { ConversationChange, ConversationTurnState } from '../../core/daemon/messages.js';
import type { TurnIo } from './processRuntime.js';

export class TurnConversationState {
  private state: ConversationTurnState;
  constructor(state: ConversationTurnState, private readonly io: TurnIo) { this.state = structuredClone(state); }
  get current(): ConversationTurnState { return this.state; }

  async save(fields: Omit<ConversationChange, 'operationId' | 'expectedVersion'>): Promise<void> {
    const change: ConversationChange = { operationId: randomUUID(), expectedVersion: this.state.version, ...fields };
    const reply = await this.io.request({ kind: 'save_conversation', change });
    if (reply.kind === 'error') throw new Error(`Conversation save rejected: ${reply.code}`);
    if (reply.kind !== 'state_saved') throw new Error('Unexpected conversation save reply');
    this.state = { ...this.state, version: reply.version,
      ...(fields.session === undefined ? {} : { session: fields.session }),
      ...(fields.proposal === undefined ? {} : { revision: fields.proposal.revision, pending: fields.proposal.pending }),
      ...(fields.approval === undefined ? {} : { approval: fields.approval }),
    };
  }

  change(fields: Omit<ConversationChange, 'operationId' | 'expectedVersion'>): ConversationChange {
    return { operationId: randomUUID(), expectedVersion: this.state.version, ...fields };
  }
}
