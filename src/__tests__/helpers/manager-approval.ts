import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { createConversationTurnService } from '../../features/manager/conversationService.js';
import type { TurnIo } from '../../features/daemonTurn/processRuntime.js';
import { turnStart } from './daemon-turn.js';
import { goalInput } from './goal-fixtures.js';

export function managerApproval(configDirectory: string, assignment: Exclude<ConversationAssignment, { kind: 'daemon' }>,
  repositoryDirectory: string, signal: AbortSignal, onReservation: () => void) {
  const input = turnStart();
  const id = conversationId(assignment);
  input.turn.conversationId = id;
  input.event.conversationId = id;
  input.state.assignment = assignment;
  input.state.pending = { revision: 1, repositoryDirectory, summary: { ...goalInput(), startBranch: 'main', integrationBranch: 'main' } };
  input.event.event = { kind: 'human_command', speaker: { namespace: 'human', id: 'test' },
    command: { kind: 'approve_summary', revision: 1 } };
  const service = createConversationTurnService(configDirectory, {
    resolve: async () => { throw new Error('Approval must not execute a provider'); }, close: async () => {},
  });
  const io: TurnIo = { signal, progress() {}, request: async (request) => {
    if (request.kind !== 'save_conversation') throw new Error('Expected conversation save');
    await writeFile(join(configDirectory, `${id}.approval.json`), JSON.stringify(request.change));
    if (request.change.approval?.state === 'reserved') onReservation();
    return { kind: 'state_saved', version: request.change.expectedVersion + 1, duplicate: false };
  } };
  return { run: () => service.execute(input, io) };
}
