import { describe, expect, it } from 'vitest';
import { ConversationCommandSchema } from '../features/manager/conversationCommands.js';
import { ConversationRequestSchema } from '../features/daemon/conversationRequests.js';
import { EventRecordSchema, EventRecordWriteSchema } from '../infra/daemon/eventRecord.js';
import { parseDaemonProcessMessage } from '../core/daemon/processProtocol.js';
import { turnStart } from './helpers/daemon-turn.js';
import { buildManagerTurnPrompt } from '../features/manager/conversationPrompt.js';

const imageId = '11111111-1111-4111-8111-111111111111';
const otherImageId = '22222222-2222-4222-8222-222222222222';

function message() {
  return { kind: 'message' as const, text: '前\n[Image #2] と [Image #1]\n後',
    imageAttachmentIds: [otherImageId, imageId] };
}

describe('manager image message references', () => {
  it('makes the stable image location and attachment ID available in the manager turn prompt', () => {
    const path = '/repository/.takt/manager-images/conversation/screen shot.png';
    const input = { lang: 'en' as const, event: { kind: 'human_command' as const,
      command: { kind: 'message' as const, text: 'Inspect [Image #1]', imageAttachmentIds: [imageId] },
      speaker: { namespace: 'local', id: 'operator' } },
      imageAttachments: [{ id: imageId, placeholder: '[Image #1]', path }] };

    const prompt = buildManagerTurnPrompt(input);

    expect(prompt).toContain(path);
    expect(prompt).toContain(imageId);
    expect(prompt).toContain(input.event.command.text);
  });
  it('transfers attachment IDs and multiline text together through the submit request', () => {
    const command = message();
    const request = { protocolVersion: 1, type: 'request', method: 'submit', requestId: 'image-request',
      params: { attachmentId: '33333333-3333-4333-8333-333333333333',
        speaker: { namespace: 'local', id: 'operator' }, command } };

    expect(ConversationRequestSchema.parse(JSON.parse(JSON.stringify(request)))).toEqual(request);
  });

  it('preserves the same image IDs from a queued event into the restored turn process message', () => {
    const input = turnStart();
    input.event.event = { kind: 'human_command', command: message(), speaker: { namespace: 'local', id: 'operator' } };
    const queued = EventRecordWriteSchema.parse({ state: 'queued', event: input.event });
    const restored = EventRecordSchema.parse(JSON.parse(JSON.stringify(queued)));
    const frame = { protocolVersion: 1, launchId: 'image-launch', kind: 'start_turn',
      input: { ...input, event: restored.event } };

    const delivered = parseDaemonProcessMessage(JSON.parse(JSON.stringify(frame)), 'image-launch');

    expect(delivered).toEqual(frame);
    expect(restored.event.event).toEqual(input.event.event);
  });

  it.each(['', '../another-conversation/image.png', 'data:image/png;base64,aGVsbG8='])('rejects a non-ID image reference %j', (invalidId) => {
    expect(ConversationCommandSchema.safeParse({ ...message(), imageAttachmentIds: [invalidId] }).success).toBe(false);
  });

  it('does not accept embedded image bytes as part of the message command', () => {
    expect(ConversationCommandSchema.safeParse({ kind: 'message', text: 'Inspect [Image #1]',
      imageAttachments: [{ placeholder: '[Image #1]', mimeType: 'image/png', data: 'aGVsbG8=' }] }).success).toBe(false);
  });

  it('continues to accept text-only messages without inventing image references', () => {
    const command = { kind: 'message', text: 'ordinary pasted text\nsecond line' };
    expect(ConversationCommandSchema.parse(command)).toEqual(command);
  });
});
