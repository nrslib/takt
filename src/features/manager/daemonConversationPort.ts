import { randomUUID } from 'node:crypto';
import type { DaemonIngress } from '../../core/daemon/ports.js';
import type { ConversationSnapshot } from '../../core/daemon/messages.js';
import { conversationId } from '../../infra/conversations/identity.js';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import { ConversationError } from './conversationErrors.js';
import { ConversationCommandSchema } from './conversationCommands.js';
import type { ConversationDelivery, ConversationInput, ConversationOpen, OutputVersion, PortOutput, SnapshotRead } from './conversationPort.js';
import { SnapshotChanges } from './snapshotChanges.js';

/** 配送先の解決は登録済みの routing 情報で行い、業務 Store を読まない。 */
export function createDaemonConversationInput(options: {
  ingress: DaemonIngress;
  resolveAssignment(selected: ConversationAssignment): Promise<ConversationAssignment>;
}) {
  const attachments = new Map<string, { input: ConversationOpen; delivery: ConversationDelivery; changes: SnapshotChanges; startedAt: number; validation: Promise<void>; pendingDeliveries: number; activitySequence: number | undefined }>();
  const activities = new Map<string, { output: Extract<PortOutput, { kind: 'activity' }>; version: OutputVersion }>();
  let accepting = true;
  const attached = (id: string) => {
    const attachment = attachments.get(id);
    if (attachment === undefined) throw new ConversationError('unavailable_attachment');
    return attachment;
  };
  const read = async (id: string, attachment: { input: ConversationOpen; changes: SnapshotChanges; startedAt: number }): Promise<SnapshotRead & Pick<ConversationSnapshot, 'generation'>> => {
    const snapshot = await options.ingress.snapshot(id);
    if (snapshot.conversationId !== id) { snapshot.cancel(); throw new ConversationError('invalid_assignment'); }
    const screen = screenSnapshot(snapshot);
    let exhausted = false;
    const projected = attachment.changes.read(screen, (async function* () {
      try {
        for await (const item of screen.items) {
          if (item.kind === 'remove') throw new Error('Conversation owner must provide a complete projection');
          if (item.kind === 'display_event') {
            if (attachment.input.assignment.kind !== 'daemon' && item.recordedAt !== undefined && Date.parse(item.recordedAt) < attachment.startedAt) continue;
            yield { kind: 'display_event' as const, event: item.event };
          } else yield item;
        }
        exhausted = true;
      } finally { if (!exhausted) screen.cancel(); }
    })());
    return { ...projected, generation: snapshot.generation, complete() { if (exhausted) { projected.complete(); screen.complete(); } },
      cancel() { projected.cancel(); screen.cancel(); } };
  };
  const replayActivityAfterRead = (attachmentId: string, snapshot: SnapshotRead & Pick<ConversationSnapshot, 'generation'>): SnapshotRead => {
    const attachment = attached(attachmentId);
    const request = attachment.input;
    let completed = false;
    let exhausted = false;
    let cancelled = false;
    return { ...snapshot, items: (async function* () {
      yield* snapshot.items;
      exhausted = true;
    })(), complete() {
      if (completed || cancelled || !exhausted) return;
      completed = true;
      snapshot.complete();
      const activity = activities.get(request.conversationId);
      if (request.binding.port !== 'tui' || attachments.get(attachmentId) !== attachment
        || activity === undefined || activity.output.operationId !== snapshot.operationId
        || activity.output.generation !== snapshot.generation || attachment.activitySequence === activity.version.stateSequence) return;
      // 状態の配送完了後、初回読込や再取得で未配送の現在値を一度だけ配送する。
      attachment.activitySequence = activity.version.stateSequence;
      void attachment.delivery.deliver(request.conversationId, activity.output, activity.version)
        .catch(() => { attachments.delete(attachmentId); });
    }, cancel() { cancelled = true; snapshot.cancel(); } };
  };
  const input: ConversationInput = {
    async open(request, delivery) {
      if (!accepting) throw new ConversationError('shutting_down');
      request = structuredClone(request);
      if (!['tui', 'slack', 'slack-inquiry'].includes(request.binding.port)) throw new ConversationError('invalid_input');
      const assignment = await options.resolveAssignment(request.assignment);
      if (conversationId(assignment) !== request.conversationId) throw new ConversationError('invalid_assignment');
      const attachment = { input: { ...request, assignment }, delivery, changes: new SnapshotChanges(), startedAt: Date.now(), validation: Promise.resolve(), pendingDeliveries: 0,
        activitySequence: undefined as number | undefined };
      const snapshot = await read(request.conversationId, attachment);
      if (!accepting) { snapshot.cancel(); throw new ConversationError('shutting_down'); }
      const attachmentId = randomUUID();
      attachments.set(attachmentId, attachment);
      return { attachmentId, read: replayActivityAfterRead(attachmentId, snapshot) };
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
        if (attachment.input.assignment.kind === 'daemon' && command.kind !== 'message') throw new ConversationError('invalid_input');
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
    async snapshot(attachmentId) {
      const attachment = attached(attachmentId);
      if (conversationId(await options.resolveAssignment(attachment.input.assignment)) !== attachment.input.conversationId) throw new ConversationError('invalid_assignment');
      return replayActivityAfterRead(attachmentId, await read(attachment.input.conversationId, attachment));
    },
    detach(attachmentId) { attachments.delete(attachmentId); },
  };
  return { ...input,
    get attachmentCount() { return attachments.size; },
    connectedPorts(id: string): string[] {
      return [...new Set([...attachments.values()].filter(({ input }) => input.conversationId === id).map(({ input }) => input.binding.port))];
    },
    async deliver(id: string, output: PortOutput, version: OutputVersion, signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) return;
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
        output.read.cancel();
        await Promise.all(recipients.map(async (attachment) => attachment.delivery.deliver(id, { kind: 'snapshot', read: await read(id, attachment) }, version)));
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
      await Promise.all(recipients.map(async (attachment) => {
        if (signal?.aborted) return;
        if (value.kind === 'turn_text') {
          if (attachment.input.binding.port === 'tui') await attachment.delivery.deliver(id, value, version, signal);
          return;
        }
        if (value.kind === 'activity') {
          if (attachment.input.binding.port !== 'tui') return;
          attachment.activitySequence = version.stateSequence;
          await attachment.delivery.deliver(id, value, version);
          return;
        }
        if (value.kind === 'progress' && attachment.pendingDeliveries >= 32) return;
        attachment.pendingDeliveries++;
        try { await attachment.delivery.deliver(id, value, version); }
        finally { attachment.pendingDeliveries--; }
      }));
    },
    stopAccepting() { accepting = false; },
    close() { accepting = false; attachments.clear(); activities.clear(); },
  };
}

function screenSnapshot(snapshot: ConversationSnapshot) {
  const items = snapshot.items;
  return { ...snapshot, items: (async function* () {
    for await (const item of items) {
      if (item.kind !== 'state') { yield item; continue; }
      const running = item.state.running;
      const startedAt = running?.operationId === snapshot.operationId && running?.generation === snapshot.generation
        ? running?.startedAt : undefined;
      yield { ...item, state: { ...item.state, queuedMessageCount: snapshot.queuedMessageCount, running: snapshot.operationId === null || snapshot.generation === null ? null
        : { operationId: snapshot.operationId, kind: 'turn', generation: snapshot.generation,
          ...(startedAt === undefined ? {} : { startedAt }) } } };
    }
  })() };
}
