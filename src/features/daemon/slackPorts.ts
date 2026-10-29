import { loadProjectConfig } from '../../infra/config/project/projectConfig.js';
import { resolveConfigValue } from '../../infra/config/resolveConfigValue.js';
import { createSlackClient, type SlackClient, type SlackEvent } from '../../infra/slack/client.js';
import { createLogger } from '../../shared/utils/debug.js';
import { createSlackConversationPort, SLACK_GOAL_APPROVE, SLACK_GOAL_DISMISS } from '../manager/slackConversationPort.js';
import type { ConversationInput } from '../manager/conversationPort.js';
import { withInquiryLock } from '../../infra/goals/inquiry-lock.js';
import { iteratePendingInquiries } from '../../infra/goals/pending-inquiries.js';
import { resolveGitRepositoryDirectory } from '../../infra/task/repositoryDirectory.js';
import { slackInquiryKey } from '../../infra/slack/inquiryBindings.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { resolveCurrentManagerAssignment } from '../manager/assignment.js';
import { SLACK_PERMISSION_BLOCK, SLACK_PERMISSION_INPUT, SLACK_PERMISSION_CALLBACK } from '../manager/slackInquiryBlocks.js';

const log = createLogger('slack');
type SlackPort = ReturnType<typeof createSlackConversationPort>;
interface RepositoryPort { allowedUserIds: readonly string[];
  port: Pick<SlackPort, 'receive' | 'receiveAction' | 'modalEndpoint' | 'receiveModal'> }
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
    case 'interactive': {
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
          action.value, typeof body.trigger_id === 'string' ? body.trigger_id : undefined);
      } else if (view !== undefined && typeof metadata === 'string' && (body.type === 'view_submission' || body.type === 'view_closed')) {
        const endpoint = selected.port.modalEndpoint(metadata);
        if (endpoint === undefined) return;
        const state = isRecord(view.state) ? view.state : undefined;
        const values = isRecord(state?.values) ? state.values : undefined;
        const block = values !== undefined && Object.hasOwn(values, SLACK_PERMISSION_BLOCK) ? values[SLACK_PERMISSION_BLOCK] : undefined;
        const input = isRecord(block) && Object.hasOwn(block, SLACK_PERMISSION_INPUT) ? block[SLACK_PERMISSION_INPUT] : undefined;
        const sentence = body.type === 'view_submission' && isRecord(input) && input.type === 'plain_text_input' && typeof input.value === 'string'
          ? input.value : undefined;
        await selected.port.receiveModal(endpoint, metadata, sentence);
      }
      return;
    }
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
  const ports = new Map<string, RepositoryPort & { repositoryDirectory: string; port: SlackPort }>();
  let listening = false;
  let stopped = false;
  let polling: Promise<void> | undefined;
  let signalStop!: () => void;
  const stopping = new Promise<void>((resolve) => { signalStop = resolve; });
  const seen = new Map<string, Set<string>>();
  const scanInquiries = async (initial: boolean): Promise<void> => {
      for (const { port, repositoryDirectory: configured } of ports.values()) {
        if (stopped) break;
        const repositoryDirectory = await resolveGitRepositoryDirectory(configured);
        const assignment = await resolveCurrentManagerAssignment({ kind: 'repository', repositoryDirectory }, options.configDirectory);
        const known = seen.get(configured) ?? new Set<string>();
        seen.set(configured, known);
        for await (const inquiry of iteratePendingInquiries(options.configDirectory, assignment)) {
          if (stopped) break;
          if (inquiry.goalId !== null && inquiry.repositoryDirectory !== repositoryDirectory) continue;
          const owner = assignment.kind === 'workspace' ? { kind: 'workspace' as const, workspaceId: assignment.workspaceId }
            : { kind: 'repository' as const, repositoryDirectory: assignment.repositoryDirectory };
          const target = inquiry.goalId === null ? { goalId: null, owner }
            : { goalId: inquiry.goalId, repositoryDirectory: inquiry.repositoryDirectory };
          const key = slackInquiryKey(target, inquiry.question.id);
          if (known.has(key)) continue;
          known.add(key);
          if (!initial) await port.delivery.deliver(conversationId(assignment), { kind: 'inquiry', target, question: inquiry.question },
            { revision: 0, stateSequence: 0, operationId: null });
        }
      }
  };
  const pollInquiries = (): Promise<void> => {
    if (polling !== undefined) return polling;
    if (stopped || !listening) return Promise.resolve();
    polling = scanInquiries(false).catch(() => { log.error('Cannot poll Slack inquiries'); }).finally(() => { polling = undefined; });
    return polling;
  };
  const stopAccepting = (): void => {
    stopped = true;
    listening = false;
    signalStop();
    client?.stopAccepting();
    for (const { port } of ports.values()) port.stopAccepting();
  };
  const close = async (): Promise<void> => {
    options.signal?.removeEventListener('abort', stopAccepting);
    stopAccepting();
    await polling;
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
      ports.set(channelId, { allowedUserIds: config.allowedUserIds, repositoryDirectory: config.repositoryDirectory,
        port: createSlackConversationPort({ ...config, configDirectory: options.configDirectory, input: options.input, client }) });
    }
    if (client !== undefined) {
      try {
        await withInquiryLock(options.configDirectory, async () => {
          if (stopped) return;
          await Promise.race([stopping, (async () => {
            await client!.start(async (event) => { if (!stopped) await dispatchSlackEvent(event, ports); });
            if (!stopped) await scanInquiries(true);
          })()]);
        });
        listening = !stopped;
      } catch {
        log.error('Cannot start Slack listener');
        await close();
      }
    }
  }
  return { get listening() { return listening; }, pollInquiries, stopAccepting, close };
}
