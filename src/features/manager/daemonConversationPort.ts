import { randomUUID } from 'node:crypto';
import type { DaemonIngress } from '../../core/daemon/ports.js';
import type { ConversationSnapshot } from '../../core/daemon/messages.js';
import { conversationId } from '../../infra/conversations/identity.js';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import { ConversationError } from './conversationErrors.js';
import { ConversationCommandSchema } from './conversationCommands.js';
import type { ConversationDelivery, ConversationInput, ConversationOpen, OutputVersion, PortOutput, SnapshotRead } from './conversationPort.js';

/** 配送先の解決は登録済みの routing 情報で行い、業務 Store を読まない。 */
export function createDaemonConversationInput(options: {
  ingress: DaemonIngress;
  resolveAssignment(selected: ConversationAssignment): Promise<ConversationAssignment>;
}) {
  const attachments = new Map<string, { input: ConversationOpen; delivery: ConversationDelivery }>();
  let accepting = true;
  const attached = (id: string) => {
    const attachment = attachments.get(id);
    if (attachment === undefined) throw new ConversationError('unavailable_attachment');
    return attachment;
  };
  const read = async (id: string): Promise<SnapshotRead> => {
    const snapshot = await options.ingress.snapshot(id);
    if (snapshot.conversationId !== id) { snapshot.cancel(); throw new ConversationError('invalid_assignment'); }
    return screenSnapshot(snapshot);
  };
  const input: ConversationInput = {
    async open(request, delivery) {
      if (!accepting) throw new ConversationError('shutting_down');
      request = structuredClone(request);
      if (!['tui', 'slack', 'slack-inquiry'].includes(request.binding.port)) throw new ConversationError('invalid_input');
      const assignment = await options.resolveAssignment(request.assignment);
      if (conversationId(assignment) !== request.conversationId) throw new ConversationError('invalid_assignment');
      const snapshot = await read(request.conversationId);
      if (!accepting) { snapshot.cancel(); throw new ConversationError('shutting_down'); }
      const attachmentId = randomUUID();
      attachments.set(attachmentId, { input: { ...request, assignment, agentOverrides: request.agentOverrides && { ...request.agentOverrides } }, delivery });
      return { attachmentId, read: snapshot };
    },
    async submit(request) {
      if (!accepting) return { kind: 'error', code: 'shutting_down', message: 'Daemon is stopping' };
      const attachment = attached(request.attachmentId);
      if (request.speaker.namespace !== attachment.input.speaker.namespace || request.speaker.id !== attachment.input.speaker.id) {
        throw new ConversationError('invalid_input');
      }
      const command = ConversationCommandSchema.parse(request.command);
      const id = attachment.input.conversationId;
      if (command.kind === 'abort_turn') {
        const snapshot = await options.ingress.snapshot(id);
        try {
          if (command.generation === undefined || snapshot.operationId !== command.operationId || snapshot.generation !== command.generation) {
            throw new ConversationError('invalid_input');
          }
          await options.ingress.control({ kind: 'interrupt', conversationId: id, operationId: command.operationId, generation: command.generation });
          return { kind: 'accepted', operationId: command.operationId };
        } finally { snapshot.cancel(); }
      }
      if (attachment.input.assignment.kind === 'daemon' && command.kind !== 'message') throw new ConversationError('invalid_input');
      const admission = await options.ingress.accept({ eventId: randomUUID(), requestId: request.requestId, conversationId: id,
        source: attachment.input.binding.port === 'tui' ? 'tui' : 'slack', occurredAt: new Date().toISOString(),
        event: command.kind === 'answer_question' ? { kind: 'inquiry_answer', command }
          : { kind: 'human_command', command, speaker: attachment.input.speaker,
            ...(attachment.input.agentOverrides === undefined ? {} : { agentOverrides: attachment.input.agentOverrides }) } });
      if (admission.kind === 'accepted') return admission;
      const codes = { capacity: 'queue_full', storage: 'storage_error', stopping: 'shutting_down' } as const;
      return { kind: 'error', code: codes[admission.reason], message: `Event rejected: ${admission.reason}` };
    },
    snapshot(attachmentId) { return read(attached(attachmentId).input.conversationId); },
    detach(attachmentId) { attachments.delete(attachmentId); },
  };
  return { ...input,
    connectedPorts(id: string): string[] {
      return [...new Set([...attachments.values()].filter(({ input }) => input.conversationId === id).map(({ input }) => input.binding.port))];
    },
    async deliver(id: string, output: PortOutput, version: OutputVersion): Promise<void> {
      const recipients = [...attachments.values()].filter(({ input }) => input.conversationId === id);
      if (output.kind === 'snapshot') {
        output.read.cancel();
        await Promise.all(recipients.map(async ({ delivery }) => delivery.deliver(id, { kind: 'snapshot', read: await read(id) }, version)));
        return;
      }
      if ((output.kind === 'pending' || output.kind === 'running') && output.state.running !== null) {
        const current = await options.ingress.snapshot(id);
        try {
          if (current.operationId !== output.state.running.operationId || current.generation === null) return;
          output = { ...output, state: { ...output.state, running: { ...output.state.running, generation: current.generation } } };
        } finally { current.cancel(); }
      }
      const value = output;
      await Promise.all(recipients.map(({ delivery }) => delivery.deliver(id, value, version)));
    },
    stopAccepting() { accepting = false; },
    close() { accepting = false; attachments.clear(); },
  };
}

function screenSnapshot(snapshot: ConversationSnapshot): SnapshotRead {
  const items = snapshot.items;
  return { ...snapshot, items: (async function* () {
    for await (const item of items) {
      if (item.kind !== 'state') { yield item; continue; }
      yield { ...item, state: { ...item.state, running: snapshot.operationId === null || snapshot.generation === null ? null
        : { operationId: snapshot.operationId, kind: 'turn', generation: snapshot.generation } } };
    }
  })() };
}
