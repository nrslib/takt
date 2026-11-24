import { randomUUID } from 'node:crypto';
import type { DaemonIngress } from '../../core/daemon/ports.js';
import type { ConversationSnapshot } from '../../core/daemon/messages.js';
import { conversationId } from '../../infra/conversations/identity.js';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import { ConversationError } from './conversationErrors.js';
import { ConversationCommandSchema } from './conversationCommands.js';
import type { ConversationDelivery, ConversationInput, ConversationOpen, OutputVersion, PortOutput, SnapshotRead, SnapshotItem } from './conversationPort.js';
import { SnapshotChanges } from './snapshotChanges.js';

/** 配送先の解決は登録済みの routing 情報で行い、業務 Store を読まない。 */
export function createDaemonConversationInput(options: {
  ingress: DaemonIngress;
  resolveAssignment(selected: ConversationAssignment): Promise<ConversationAssignment>;
}) {
  const attachments = new Map<string, { input: ConversationOpen; delivery: ConversationDelivery; changes: SnapshotChanges; startedAt: number; validation: Promise<void>; activitySequence?: number }>();
  const activities = new Map<string, { output: Extract<PortOutput, { kind: 'activity' }>; version: OutputVersion }>();
  let accepting = true;
  let attachmentGeneration = 0;
  const attached = (id: string) => {
    const attachment = attachments.get(id);
    if (attachment === undefined) throw new ConversationError('unavailable_attachment');
    return attachment;
  };
  const project = (snapshot: Omit<SnapshotRead, 'items'> & { items: AsyncIterable<SnapshotItem & { recordedAt?: string }>; queuedMessageCount?: number },
    attachment: { input: ConversationOpen; changes: SnapshotChanges; startedAt: number }): SnapshotRead => {
    return attachment.changes.read(snapshot, (async function* () {
        for await (const item of snapshot.items) {
          if (item.kind === 'remove') throw new Error('Conversation owner must provide a complete projection');
          if (item.kind === 'tool_history' && attachment.input.binding.port !== 'tui') continue;
          if (item.kind === 'display_event') {
            if (attachment.input.assignment.kind !== 'daemon' && item.recordedAt !== undefined && Date.parse(item.recordedAt) < attachment.startedAt) continue;
            yield { kind: 'display_event' as const, event: item.event };
          } else if (item.kind === 'state') yield { ...item, state: { ...item.state, queuedMessageCount: snapshot.queuedMessageCount } };
          else yield item;
        }
      })());
  };
  const read = async (id: string, attachment: { input: ConversationOpen; changes: SnapshotChanges; startedAt: number },
    capture?: (read: SnapshotRead, snapshot: ConversationSnapshot) => void): Promise<SnapshotRead> => {
    let projected: SnapshotRead | undefined;
    await options.ingress.snapshot(id, { toolHistory: attachment.input.binding.port === 'tui', capture(snapshot) {
      if (snapshot.conversationId !== id) { snapshot.cancel(); throw new ConversationError('invalid_assignment'); }
      projected = project(snapshot, attachment);
      capture?.(projected, snapshot);
    } });
    if (projected === undefined) throw new Error('Conversation snapshot was not captured');
    return projected;
  };
  // main と同じく、途中接続・再接続した画面へ、読取を送り終えた時点の現在の activity を、同じ接続の FIFO で一度だけ送る。
  const replayActivityAfterRead = (attachmentId: string, attachment: { input: ConversationOpen; delivery: ConversationDelivery; activitySequence?: number },
    snapshot: Pick<ConversationSnapshot, 'operationId' | 'generation'>, read: SnapshotRead): SnapshotRead => {
    let cancelled = false;
    return { ...read, cancel() { cancelled = true; read.cancel(); }, complete() {
      read.complete();
      const activity = activities.get(attachment.input.conversationId);
      if (cancelled || attachment.input.binding.port !== 'tui' || attachments.get(attachmentId) !== attachment || activity === undefined
        || activity.output.operationId !== snapshot.operationId || activity.output.generation !== snapshot.generation
        || attachment.activitySequence === activity.version.stateSequence) return;
      attachment.activitySequence = activity.version.stateSequence;
      void attachment.delivery.deliver(attachment.input.conversationId, activity.output, activity.version)
        .catch(() => { attachments.delete(attachmentId); });
    } };
  };
  const input: ConversationInput = {
    async open(request, delivery, enqueueSnapshot) {
      if (!accepting) throw new ConversationError('shutting_down');
      request = structuredClone(request);
      if (!['tui', 'slack', 'slack-inquiry'].includes(request.binding.port)) throw new ConversationError('invalid_input');
      const assignment = await options.resolveAssignment(request.assignment);
      if (conversationId(assignment) !== request.conversationId) throw new ConversationError('invalid_assignment');
      const attachment = { input: { ...request, assignment }, delivery, changes: new SnapshotChanges(), startedAt: Date.now(), validation: Promise.resolve() };
      const attachmentId = randomUUID();
      const snapshot = await read(request.conversationId, attachment, (snapshot, captured) => {
        if (!accepting) throw new ConversationError('shutting_down');
        enqueueSnapshot?.(replayActivityAfterRead(attachmentId, attachment, captured, snapshot), attachmentId);
        attachments.set(attachmentId, attachment);
        attachmentGeneration++;
      });
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
      let finishValidation = (): void => {};
      if (command.kind !== 'abort_turn') {
        const previous = attachment.validation;
        attachment.validation = new Promise<void>((resolve) => { finishValidation = resolve; });
        await previous;
      }
      try {
        if (conversationId(await options.resolveAssignment(attachment.input.assignment)) !== attachment.input.conversationId) {
          return { kind: 'error', code: 'invalid_assignment', message: 'Conversation assignment changed' };
        }
        if (!accepting) return { kind: 'error', code: 'shutting_down', message: 'Daemon is stopping' };
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
        if (attachment.input.assignment.kind === 'daemon' && !['message', 'answer_question', 'approve_summary', 'dismiss_summary'].includes(command.kind)) throw new ConversationError('invalid_input');
        if (command.kind === 'approve_summary' || command.kind === 'dismiss_summary') {
          const snapshot = await options.ingress.snapshot(id);
          try {
            const state = snapshot.turnState;
            const registered = command.kind === 'approve_summary' && !command.requirePending
              && state.approval?.revision === command.revision && state.approval.state === 'registered';
            if (!registered && (state.revision !== command.revision || state.pending?.revision !== command.revision)) {
              return { kind: 'error', code: 'stale_summary', message: 'The displayed proposal has changed' };
            }
          } finally { snapshot.cancel(); }
        }
        const accepted = options.ingress.accept({ eventId: randomUUID(), requestId: request.requestId, conversationId: id,
          source: attachment.input.binding.port === 'tui' ? 'tui' : 'slack', occurredAt: new Date().toISOString(),
          event: command.kind === 'answer_question' ? { kind: 'inquiry_answer', command }
            : { kind: 'human_command', command, speaker: attachment.input.speaker,
              ...(attachment.input.agentOverrides === undefined ? {} : { agentOverrides: attachment.input.agentOverrides }) } });
        // 同じ画面の入力順を保つ。保存の完了待ちは、次の入力の検証を止めない。
        finishValidation();
        const admission = await accepted;
        if (admission.kind === 'accepted') return admission;
        const codes = { capacity: 'queue_full', storage: 'storage_error', stopping: 'shutting_down' } as const;
        return { kind: 'error', code: codes[admission.reason], message: `Event rejected: ${admission.reason}` };
      } finally { finishValidation(); }
    },
    async snapshot(attachmentId, request) {
      const attachment = attached(attachmentId);
      if (conversationId(await options.resolveAssignment(attachment.input.assignment)) !== attachment.input.conversationId) throw new ConversationError('invalid_assignment');
      return read(attachment.input.conversationId, attachment, (snapshot, captured) => {
        request?.enqueueSnapshot?.(replayActivityAfterRead(attachmentId, attachment, captured, snapshot));
      });
    },
    detach(attachmentId) { attachments.delete(attachmentId); },
  };
  return { ...input,
    get attachmentCount() { return attachments.size; },
    get attachmentGeneration() { return attachmentGeneration; },
    connectedPorts(id: string): string[] {
      return [...new Set([...attachments.values()].filter(({ input }) => input.conversationId === id).map(({ input }) => input.binding.port))];
    },
    async deliver(id: string, output: PortOutput, version: OutputVersion, signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) return;
      if (output.kind === 'inquiry' && (output.question.status !== 'pending' || output.question.recipient !== 'human')) return;
      if (output.kind === 'activity') {
        const previous = activities.get(id);
        if (previous !== undefined && previous.version.stateSequence > version.stateSequence) return;
        activities.set(id, { output, version });
      }
      else if (output.kind === 'running' || output.kind === 'pending') {
        const activity = activities.get(id)?.output;
        if (output.state.running === null || output.state.running.operationId !== activity?.operationId
          || output.state.running.generation !== activity?.generation) activities.delete(id);
      } else if (output.kind === 'result' && activities.get(id)?.output.operationId === output.operationId) activities.delete(id);
      const recipients = [...attachments.values()].filter(({ input }) => input.conversationId === id);
      if (output.kind === 'snapshot') {
        // main と同じく、受け手ごとに dispatcher を通して読み直す。待ち件数は dispatcher だけが知っている。
        output.read.cancel();
        await Promise.all(recipients.map(async (attachment) => {
          let delivered: Promise<unknown> = Promise.resolve();
          await read(id, attachment, (projected) => {
            delivered = attachment.delivery.deliver(id, { kind: 'snapshot', read: projected }, version);
          });
          await delivered;
        }));
        return;
      }
      const value = output;
      await Promise.all(recipients.map(async (attachment) => {
        if (signal?.aborted) return;
        if ((value.kind === 'tool_started' || value.kind === 'tool_output' || value.kind === 'tool_completed') && attachment.input.binding.port !== 'tui') return;
        if (value.kind === 'turn_text') {
          if (attachment.input.binding.port === 'tui') await attachment.delivery.deliver(id, value, version, signal);
          return;
        }
        if (value.kind === 'activity') {
          if (attachment.input.binding.port !== 'tui') return;
          attachment.activitySequence = version.stateSequence;
        }
        await attachment.delivery.deliver(id, value, version);
      }));
    },
    stopAccepting() { accepting = false; },
    close() { accepting = false; attachments.clear(); activities.clear(); },
  };
}
