import { createHash } from 'node:crypto';
import type { ManagerAssignment } from '../manager/startupResolution.js';
import type { ConversationDelivery } from '../manager/conversationPort.js';
import { createSlackClient, type SlackClient, type SlackEvent } from '../../infra/slack/client.js';
import { reportDaemonError } from '../../infra/daemon/diagnostics.js';
import { createSlackConversationPort, SLACK_GOAL_APPROVE, SLACK_GOAL_DISMISS } from '../manager/slackConversationPort.js';
import type { ConversationInput } from '../manager/conversationPort.js';
import { SLACK_PERMISSION_BLOCK, SLACK_PERMISSION_INPUT, SLACK_PERMISSION_CALLBACK } from '../manager/slackInquiryBlocks.js';
import { createDirectorSlackConversationPort } from '../director/slackConversationPort.js';
import type { DirectorNotificationDelivery } from '../director/notificationDelivery.js';
import type { GlobalConfig } from '../../core/models/config-types.js';
import type { Language } from '../../core/models/types.js';


type SlackPort = ReturnType<typeof createSlackConversationPort>;
interface RepositoryPort { allowedUserIds: readonly string[];
  port: Pick<SlackPort, 'receive' | 'isInquiryThread' | 'receiveAction' | 'modalEndpoint' | 'receiveModal'> }
interface DirectorPort { channelId: string; allowedUserIds: readonly string[];
  port: ReturnType<typeof createDirectorSlackConversationPort> }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function dispatchSlackEvent(event: SlackEvent, ports: ReadonlyMap<string, RepositoryPort>, director?: DirectorPort): Promise<void> {
  const body = event.body;
  if (!isRecord(body)) return;
  const message = event.type === 'events_api' ? body.event : body;
  if (!isRecord(message)) return;
  const teamId = event.type === 'events_api' ? body.team_id : isRecord(body.team) ? body.team.id : undefined;
  let channelId = event.type === 'events_api' ? message.channel : isRecord(body.channel) ? body.channel.id : undefined;
  const userId = event.type === 'events_api' ? message.user : isRecord(body.user) ? body.user.id : undefined;
  const view = isRecord(body.view) ? body.view : undefined;
  const metadata = view?.private_metadata;
  if (event.type === 'interactive' && (body.type === 'view_submission' || body.type === 'view_closed')) {
    if (view?.callback_id !== SLACK_PERMISSION_CALLBACK || typeof metadata !== 'string') return;
    const endpoints = [...ports.values()].map(({ port }) => port.modalEndpoint(metadata)).filter((endpoint) => endpoint !== undefined);
    if (endpoints.length !== 1) return;
    const endpoint = endpoints[0]!;
    if (endpoint.teamId !== teamId || endpoint.userId !== userId || (channelId !== undefined && channelId !== endpoint.channelId)) return;
    channelId = endpoint.channelId;
  }
  if (typeof teamId !== 'string' || typeof channelId !== 'string' || typeof userId !== 'string') return;
  const selected = ports.get(channelId);
  const requestId = createHash('sha256').update(JSON.stringify(event.type === 'events_api'
    ? [event.type, teamId, channelId, userId, message.ts] : [event.type, body])).digest('hex');
  switch (event.type) {
    case 'events_api': {
      if (message.type !== 'message' || (message.subtype !== undefined && message.subtype !== 'thread_broadcast') || message.bot_id !== undefined
        || message.channel_type === 'im' || message.channel_type === 'mpim'
        || typeof message.ts !== 'string' || typeof message.text !== 'string' || message.text.trim().length === 0) return;
      const parentTs = message.thread_ts ?? message.ts;
      if (typeof parentTs !== 'string') return;
      const destination = director?.channelId === channelId && !await selected?.port.isInquiryThread(channelId, parentTs) ? director : selected;
      if (destination === undefined || !destination.allowedUserIds.includes(userId)) return;
      await destination.port.receive({ teamId, channelId, userId, parentTs }, message.text, requestId);
      return;
    }
    case 'interactive': {
      if (selected === undefined || !selected.allowedUserIds.includes(userId)) return;
      if (body.type === 'block_actions') {
        if (!isRecord(body.container) || body.container.type !== 'message' || body.container.channel_id !== channelId
          || typeof body.container.message_ts !== 'string' || !isRecord(body.message) || body.message.ts !== body.container.message_ts
          || !Array.isArray(body.actions) || body.actions.length !== 1) return;
        const action: unknown = body.actions[0];
        if (!isRecord(action) || action.type !== 'button' || typeof action.action_id !== 'string' || typeof action.value !== 'string') return;
        const parentTs = action.action_id === SLACK_GOAL_APPROVE || action.action_id === SLACK_GOAL_DISMISS
          ? body.message.thread_ts : body.container.message_ts;
        if (typeof parentTs !== 'string') return;
        await selected.port.receiveAction({ teamId, channelId, userId, parentTs }, action.action_id,
          action.value, typeof body.trigger_id === 'string' ? body.trigger_id : undefined, requestId);
      } else if (view !== undefined && typeof metadata === 'string' && (body.type === 'view_submission' || body.type === 'view_closed')) {
        const endpoint = selected.port.modalEndpoint(metadata);
        if (endpoint === undefined) return;
        const state = isRecord(view.state) ? view.state : undefined;
        const values = isRecord(state?.values) ? state.values : undefined;
        const block = values !== undefined && Object.hasOwn(values, SLACK_PERMISSION_BLOCK) ? values[SLACK_PERMISSION_BLOCK] : undefined;
        const input = isRecord(block) && Object.hasOwn(block, SLACK_PERMISSION_INPUT) ? block[SLACK_PERMISSION_INPUT] : undefined;
        const sentence = body.type === 'view_submission' && isRecord(input) && input.type === 'plain_text_input' && typeof input.value === 'string'
          ? input.value : undefined;
        await selected.port.receiveModal(endpoint, metadata, sentence, requestId);
      }
      return;
    }
    default: return;
  }
}

export interface SlackRepositoryConfig {
  repositoryDirectory: string;
  resolveAssignment(): Promise<ManagerAssignment>;
  channelId: string;
  allowedUserIds: readonly string[];
  language: Language;
}

export async function createDaemonSlackPorts(options: {
  repositories: readonly SlackRepositoryConfig[]; configDirectory: string; input: ConversationInput;
  tokens: { appToken: string; botToken: string } | undefined;
  clientFactory?: typeof createSlackClient;
  signal?: AbortSignal;
  director?: { slack: NonNullable<GlobalConfig['director']>['slack']; language: Language };
}) {
  let client: SlackClient | undefined;
  let director: DirectorPort | undefined;
  const ports = new Map<string, RepositoryPort & { port: SlackPort }>();
  let listening = false;
  let stopped = false;
  let signalStopped!: () => void;
  const stopping = new Promise<void>((resolve) => { signalStopped = resolve; });
  const stopAccepting = (): void => {
    stopped = true;
    signalStopped();
    listening = false;
    client?.stopAccepting();
    for (const { port } of ports.values()) port.stopAccepting();
    director?.port.stopAccepting();
  };
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      options.signal?.removeEventListener('abort', stopAccepting);
      stopAccepting();
      await Promise.all([...ports.values()].map(({ port }) => port.close()));
      await director?.port.close();
      director = undefined;
      ports.clear();
      await client?.close();
    })();
    return closing;
  };
  options.signal?.addEventListener('abort', stopAccepting, { once: true });
  if (options.signal?.aborted) stopAccepting();
  if (!stopped && options.tokens !== undefined) {
    const candidates = new Map<string, SlackRepositoryConfig[]>();
    for (const config of options.repositories) {
      const group = candidates.get(config.channelId) ?? [];
      group.push(config);
      candidates.set(config.channelId, group);
    }
    for (const [channelId, group] of candidates) {
      if (group.length > 1) {
        reportDaemonError(`Slack channel is configured by multiple repositories: ${channelId} (${group.map((config) => config.repositoryDirectory).join(', ')})`);
        continue;
      }
      const config = group[0]!;
      client ??= (options.clientFactory ?? createSlackClient)(options.tokens);
      ports.set(channelId, { allowedUserIds: config.allowedUserIds,
        port: createSlackConversationPort({ ...config, configDirectory: options.configDirectory, input: options.input, client }) });
    }
    const configuredDirector = options.director?.slack;
    if (configuredDirector !== undefined) {
      client ??= (options.clientFactory ?? createSlackClient)(options.tokens);
      director = { ...configuredDirector, port: createDirectorSlackConversationPort({ channelId: configuredDirector.channelId,
        input: options.input, client, language: options.director!.language }) };
    }
    if (client !== undefined) {
      try {
        await Promise.race([stopping, client.start(async (event) => { if (!stopped) await dispatchSlackEvent(event, ports, director); })]);
        listening = !stopped;
        if (stopped) await close();
      } catch {
        reportDaemonError('Cannot start Slack listener');
        await close();
      }
    }
  }
  const notifications: DirectorNotificationDelivery = {
    async deliver(batch) {
      if (director !== undefined) await director.port.notifications.deliver(batch);
    },
  };
  // 問い合わせの変化は watcher/保存所有者から配送する。時計で業務 Store を走査しない。
  const delivery: ConversationDelivery = {
    async deliver(id, output, version) {
      const results = await Promise.all([...ports.values()].map(({ port }) => port.delivery.deliver(id, output, version)));
      return results.find((result) => result.kind === 'unavailable') ?? { kind: 'delivered' };
    },
  };
  return { get listening() { return listening; }, notifications, delivery, stopAccepting, close };
}
