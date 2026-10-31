import { createConnection, type Socket } from 'node:net';
import { expect, vi } from 'vitest';
import { ConversationFrameDecoder, encodeConversationFrame } from '../../features/daemon/conversationFrames.js';
import type { ConversationState } from '../../features/manager/conversationPort.js';

interface Frame {
  type: string; conversationId?: string; requestId?: string; result?: { attachmentId: string; kind: string; operationId: string; read: { transferId: string } };
  output?: { kind: string; purpose?: string; transferId: string; data: string; itemIndex: number; fragmentIndex: number; finalFragment: boolean;
    itemCount: number; revision: number; stateSequence: number; operationId: string | null };
}
export class Client {
  readonly frames: Frame[] = [];
  readonly sizes: number[] = [];
  readonly socket: Socket;
  private requestId = 0;
  constructor(endpoint: string) {
    this.socket = createConnection(endpoint);
    this.socket.on('error', () => {});
    const decoder = new ConversationFrameDecoder();
    let length = 0;
    this.socket.on('data', (bytes: Buffer) => {
      for (const byte of bytes) { length++; if (byte === 10) { this.sizes.push(length); length = 0; } }
      this.frames.push(...[...decoder.decode(bytes)] as Frame[]);
    });
  }
  async request(method: string, params: unknown) {
    const requestId = String(++this.requestId);
    this.socket.write(encodeConversationFrame({ protocolVersion: 1, type: 'request', requestId, method, params }));
    await vi.waitFor(() => expect(this.frames.some((frame) => frame.requestId === requestId),
      `Missing ${method} response; disconnected=${this.socket.destroyed}`).toBe(true), { timeout: 5_000 });
    return this.frames.find((frame) => frame.requestId === requestId)!;
  }
  async items(transferId: string): Promise<unknown[]> {
    await vi.waitFor(() => expect(this.frames.some(({ output }) => output?.transferId === transferId && output.kind === 'transfer_end')).toBe(true), { timeout: 5_000 });
    const items: unknown[] = [];
    let fragments: Buffer[] = [];
    let fragmentIndex = 0;
    for (const { output } of this.frames) {
      if (output?.transferId !== transferId || output.kind !== 'transfer_data') continue;
      expect(output.itemIndex).toBe(items.length);
      expect(output.fragmentIndex).toBe(fragmentIndex++);
      const bytes = Buffer.from(output.data, 'base64'); expect(bytes.toString('base64')).toBe(output.data);
      fragments.push(bytes);
      if (output.finalFragment) {
        items.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(fragments))) as unknown);
        fragments = []; fragmentIndex = 0;
      }
    }
    expect(fragments).toHaveLength(0);
    expect(this.frames.find(({ output }) => output?.kind === 'transfer_end' && output.transferId === transferId)!.output!.itemCount).toBe(items.length);
    return items;
  }

  latestState(): ConversationState | undefined {
    const transfers = new Map<string, { sequence: number; revision: number; conversationId: string; fragments: Buffer[] }>();
    let latest: { sequence: number; state: ConversationState } | undefined;
    let snapshot: string | undefined;
    for (const frame of this.frames) {
      const output = frame.output;
      if (output === undefined) continue;
      if (output.kind === 'transfer_start') {
        if (output.purpose === 'snapshot') { if (snapshot !== undefined) transfers.delete(snapshot); snapshot = output.transferId; }
        transfers.set(output.transferId, { sequence: output.stateSequence, revision: output.revision,
          conversationId: frame.conversationId!, fragments: [] });
      }
      const transfer = transfers.get(output.transferId);
      if (transfer === undefined) continue;
      if (output.kind === 'transfer_data') {
        transfer.fragments.push(Buffer.from(output.data, 'base64'));
        if (!output.finalFragment) continue;
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(transfer.fragments))) as { kind: string; state?: ConversationState };
        transfer.fragments = [];
        if (!['state', 'pending', 'running'].includes(value.kind) || value.state === undefined) continue;
        expect(value.state.conversationId).toBe(transfer.conversationId); expect(value.state.revision).toBe(transfer.revision);
        if (latest === undefined || transfer.sequence >= latest.sequence && value.state.revision >= latest.state.revision) {
          latest = { sequence: transfer.sequence, state: value.state };
        }
      }
      if (output.kind === 'transfer_end' || output.kind === 'transfer_error') transfers.delete(output.transferId);
    }
    return latest?.state;
  }
}
