import { loadProjectConfig } from '../../infra/config/project/projectConfig.js';
import { resolveConfigValue } from '../../infra/config/resolveConfigValue.js';
import { createSlackClient, type SlackClient, type SlackEvent } from '../../infra/slack/client.js';
import { createLogger } from '../../shared/utils/debug.js';
import { createSlackConversationPort } from '../manager/slackConversationPort.js';
import type { ConversationInput } from '../manager/conversationPort.js';

const log = createLogger('slack');
type SlackPort = ReturnType<typeof createSlackConversationPort>;
interface RepositoryPort { allowedUserIds: readonly string[]; port: Pick<SlackPort, 'receive'> }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadSlackRepositoryConfig(repositoryDirectory: string) {
  const slack = loadProjectConfig(repositoryDirectory).manager?.slack;
  return slack === undefined ? undefined : {
    repositoryDirectory, ...slack, language: resolveConfigValue(repositoryDirectory, 'language'),
  };
}

export async function dispatchSlackEvent(event: SlackEvent, ports: ReadonlyMap<string, RepositoryPort>): Promise<void> {
  const body = event.body;
  if (!isRecord(body)) return;
  const message = event.type === 'events_api' ? body.event : body;
  if (!isRecord(message)) return;
  const teamId = event.type === 'events_api' ? body.team_id : isRecord(body.team) ? body.team.id : undefined;
  const channelId = event.type === 'events_api' ? message.channel : isRecord(body.channel) ? body.channel.id : undefined;
  const userId = event.type === 'events_api' ? message.user : isRecord(body.user) ? body.user.id : undefined;
  if (typeof teamId !== 'string' || typeof channelId !== 'string' || typeof userId !== 'string') return;
  const selected = ports.get(channelId);
  if (selected === undefined || !selected.allowedUserIds.includes(userId)) return;
  // Authorization precedes the event split so later interactive handlers share it.
  switch (event.type) {
    case 'events_api': {
      if (message.type !== 'message' || (message.subtype !== undefined && message.subtype !== 'thread_broadcast') || message.bot_id !== undefined
        || message.channel_type === 'im' || message.channel_type === 'mpim'
        || typeof message.ts !== 'string' || typeof message.text !== 'string' || message.text.trim().length === 0) return;
      const parentTs = message.thread_ts ?? message.ts;
      if (typeof parentTs !== 'string') return;
      await selected.port.receive({ teamId, channelId, userId, parentTs }, message.text);
      return;
    }
    case 'interactive': return;
    default: return;
  }
}

export async function createDaemonSlackPorts(options: {
  projects: readonly string[]; configDirectory: string; input: ConversationInput;
  tokens: { appToken: string; botToken: string } | undefined;
  clientFactory?: typeof createSlackClient;
  signal?: AbortSignal;
}) {
  let client: SlackClient | undefined;
  const ports = new Map<string, RepositoryPort & { port: SlackPort }>();
  let listening = false;
  let stopped = false;
  const stopAccepting = (): void => {
    stopped = true;
    listening = false;
    client?.stopAccepting();
    for (const { port } of ports.values()) port.stopAccepting();
  };
  const close = async (): Promise<void> => {
    options.signal?.removeEventListener('abort', stopAccepting);
    stopAccepting();
    for (const { port } of ports.values()) port.close();
    ports.clear();
    await client?.close();
  };
  options.signal?.addEventListener('abort', stopAccepting, { once: true });
  if (options.signal?.aborted) stopAccepting();
  if (!stopped && options.tokens !== undefined) {
    const candidates = new Map<string, NonNullable<ReturnType<typeof loadSlackRepositoryConfig>>[]>();
    for (const repositoryDirectory of new Set(options.projects)) {
      try {
        const config = loadSlackRepositoryConfig(repositoryDirectory);
        if (config === undefined) continue;
        const group = candidates.get(config.channelId) ?? [];
        group.push(config);
        candidates.set(config.channelId, group);
      } catch { log.error('Cannot load Slack repository configuration', { repositoryDirectory }); }
    }
    for (const [channelId, group] of candidates) {
      if (group.length > 1) {
        log.error('Slack channel is configured by multiple repositories; all are disabled', {
          channelId, repositories: group.map(({ repositoryDirectory }) => repositoryDirectory),
        });
        continue;
      }
      const config = group[0]!;
      client ??= (options.clientFactory ?? createSlackClient)(options.tokens);
      ports.set(channelId, { allowedUserIds: config.allowedUserIds,
        port: createSlackConversationPort({ ...config, configDirectory: options.configDirectory, input: options.input, client }) });
    }
    if (client !== undefined) {
      try {
        await client.start(async (event) => { if (!stopped) await dispatchSlackEvent(event, ports); });
        listening = !stopped;
      } catch {
        log.error('Cannot start Slack listener');
        await close();
      }
    }
  }
  return { get listening() { return listening; }, stopAccepting, close };
}
