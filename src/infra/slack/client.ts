import { SocketModeClient, LogLevel, type Logger } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import type { KnownBlock, ModalView } from '@slack/types';
import { createLogger } from '../../shared/utils/debug.js';

export interface SlackEvent { type: string; body: unknown }
export interface SlackThread { channelId: string; parentTs: string }
export type SlackDeliveryResult = { kind: 'delivered' } | { kind: 'unavailable'; reason: string };
export type SlackPostResult = { kind: 'delivered'; parentTs: string } | { kind: 'unavailable'; reason: string };
export interface SlackClient {
  start(receive: (event: SlackEvent) => Promise<void>): Promise<void>;
  postThreadMessage(thread: SlackThread, text: string): Promise<SlackDeliveryResult>;
  postMessage(channelId: string, text: string, blocks: KnownBlock[]): Promise<SlackPostResult>;
  openModal(triggerId: string, view: ModalView): Promise<SlackDeliveryResult>;
  stopAccepting(): void;
  close(): Promise<void>;
}

const log = createLogger('slack');
// SDK diagnostics may contain credentials, payloads or connection URLs.
const sdkLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, setName() {},
  getLevel: () => LogLevel.ERROR,
};
const REQUEST_TIMEOUT_MS = 10_000;
async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Slack operation timed out')), REQUEST_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

export function createSlackClient(tokens: { appToken: string; botToken: string }): SlackClient {
  const options = { logger: sdkLogger, timeout: REQUEST_TIMEOUT_MS, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true };
  const socket = new SocketModeClient({ appToken: tokens.appToken, logger: sdkLogger,
    clientOptions: { timeout: REQUEST_TIMEOUT_MS, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true } });
  const web = new WebClient(tokens.botToken, options);
  let accepting = true;
  let closed = false;
  socket.on('error', () => log.error('Slack connection error'));
  return {
    async start(receive) {
      socket.on('slack_event', async (event: SlackEvent & { ack(): Promise<void> }) => {
        try {
          await event.ack();
          if (accepting) await receive({ type: event.type, body: event.body });
        } catch { log.error('Cannot handle Slack event'); }
      });
      try {
        const starting = socket.start().then(async () => { if (closed) await socket.disconnect(); });
        await bounded(starting);
      } catch { throw new Error('Cannot connect to Slack'); }
    },
    async postThreadMessage(thread, text) {
      try {
        await bounded(web.chat.postMessage({ channel: thread.channelId, thread_ts: thread.parentTs,
          text, unfurl_links: false, unfurl_media: false }));
        return { kind: 'delivered' };
      } catch {
        log.error('Cannot post Slack reply');
        return { kind: 'unavailable', reason: 'Slack reply unavailable' };
      }
    },
    async postMessage(channelId, text, blocks) {
      try {
        const response = await bounded(web.chat.postMessage({ channel: channelId, text, blocks,
          unfurl_links: false, unfurl_media: false }));
        if (!response.ok || typeof response.ts !== 'string' || response.ts.length === 0) throw new Error('Missing Slack timestamp');
        return { kind: 'delivered', parentTs: response.ts };
      } catch {
        log.error('Cannot post Slack inquiry');
        return { kind: 'unavailable', reason: 'Slack inquiry unavailable' };
      }
    },
    async openModal(triggerId, view) {
      try {
        const response = await bounded(web.views.open({ trigger_id: triggerId, view }));
        if (!response.ok) throw new Error('Slack modal unavailable');
        return { kind: 'delivered' };
      } catch {
        log.error('Cannot open Slack modal');
        return { kind: 'unavailable', reason: 'Slack modal unavailable' };
      }
    },
    stopAccepting() { accepting = false; },
    async close() {
      accepting = false;
      closed = true;
      try { await bounded(socket.disconnect()); }
      catch { log.error('Cannot close Slack connection'); }
    },
  };
}
