import { getErrorMessage } from '../../shared/utils/error.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DaemonBus, TurnRunner } from '../../core/daemon/ports.js';
import { registerDaemonOwner, removeDaemonOwner, type DaemonOwner } from '../../infra/daemon/owner.js';
import { readProcessOwner, AsyncProcess } from '../../infra/daemon/process.js';
import { AsyncCommand } from '../../infra/daemon/command.js';
import { FileEventStore } from '../../infra/daemon/eventStore.js';
import { ConversationStateStore } from '../../infra/daemon/conversationStateStore.js';
import { DaemonNotifications } from '../../infra/daemon/notifications.js';
import { WatchObservations } from './watchers/observations.js';
import { FileWatchRecords } from '../../infra/daemon/watchRecords.js';
import { DaemonPersistedFiles } from '../../infra/daemon/persistedFiles.js';
import { readPrivateFile } from '../../infra/daemon/privateFile.js';
import { resolveDaemonConfigDirectory } from '../../infra/daemon/ipcEndpoint.js';
import { installDaemonErrorLog, reportDaemonError } from '../../infra/daemon/diagnostics.js';
import { DaemonLogger } from '../../infra/daemon/logger.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { createDaemonConversationInput } from '../manager/daemonConversationPort.js';
import { createConversationIpcServer } from './conversationIpcServer.js';
import { createDaemonSlackPorts, type SlackRepositoryConfig } from './slackPorts.js';
import { DaemonDispatcher } from './dispatcher.js';
import { createTurnProcessHost } from './turnProcessHost.js';
import { DaemonConversations } from './conversationState.js';
import { DaemonRouting, routeAssignment } from './routing.js';
import { createDaemonStateRequests } from './stateRequests.js';
import { startDaemonWatchers } from './watchers/index.js';
import { FileDaemonWatchSource } from './watchSource.js';
import { receiveInboxChange, restoreLegacyConversations, retireLegacyPatrols } from './inbox.js';
import { globalDaemonConfiguration, readDaemonConfiguration } from './configuration.js';

/** 所有権とシグナルは専用プロセス入口が所有し、ここでは部品の寿命を一元化する。 */
export async function startDaemon(options: {
  configDirectory: string;
  owner: DaemonOwner;
  tokens: { appToken: string; botToken: string } | undefined;
  signal: AbortSignal;
  runnerFactory?: (bus: DaemonBus) => TurnRunner;
}) {
  const directory = options.configDirectory;
  const routing = new DaemonRouting(directory);
  const eventStore = new FileEventStore(directory);
  const store = new ConversationStateStore(directory);
  const notifications = new DaemonNotifications(directory);
  let ipc: Awaited<ReturnType<typeof createConversationIpcServer>> | undefined;
  let slack: Awaited<ReturnType<typeof createDaemonSlackPorts>> | undefined;
  let resolveSlack!: (value: typeof slack) => void;
  const slackReady = new Promise<typeof slack>((resolve) => { resolveSlack = resolve; });
  let watchers: ReturnType<typeof startDaemonWatchers> | undefined;
  let storageRetry: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let finishStartup!: () => void;
  const startupFinished = new Promise<void>((resolve) => { finishStartup = resolve; });
  const conversations = new DaemonConversations(store, routing, notifications, async (id, output, version) => {
    await input.deliver(id, output, version);
    if (output.kind === 'inquiry') await (await slackReady)?.delivery.deliver(id, output, version);
    if (output.kind === 'result' && id === conversationId({ kind: 'daemon' })) {
      const batch = [];
      for await (const notice of notifications.iterate()) if (notice.turnOperationId === output.operationId) batch.push(notice);
      await (await slackReady)?.notifications.deliver(batch);
    }
    if (output.kind === 'notice' && id === conversationId({ kind: 'daemon' }) && (version.operationId === null || output.id.startsWith('result-'))) {
      await (await slackReady)?.notifications.deliver([{ id: output.id, message: output.message }]);
    }
  }, reportDaemonError);
  const bus: DaemonBus = { post: (message) => dispatcher.post(message), request: (turn, request, signal) => dispatcher.request(turn, request, signal) };
  const runner = options.runnerFactory?.(bus) ?? createTurnProcessHost({ configDirectory: directory, bus, onError: reportDaemonError });
  const resources = { async close() {
    await startupFinished;
    const results = await Promise.allSettled([watchers?.close(), slack?.close(), ipc?.close()]);
    const delivery = await Promise.allSettled([conversations.close()]);
    input.close();
    const errors = [...results, ...delivery].flatMap((result) => result.status === 'rejected' ? [result.reason as unknown] : []);
    if (errors.length > 0) throw new AggregateError(errors, 'Cannot close daemon resources');
  } };
  const dispatcher: DaemonDispatcher = new DaemonDispatcher({ store: eventStore, conversations, stateRequests: createDaemonStateRequests({ conversations,
    ingress: { accept: (event) => dispatcher.accept(event) }, connectedPorts: (id) => input.connectedPorts(id) }),
  runner: { start(value, signal) { conversations.started(value); runner.start(value, signal); },
    interrupt: (turn) => runner.interrupt(turn), resultCommitted: (turn) => runner.resultCommitted(turn), close: () => runner.close() },
  resources, limits: { maxPendingEvents: 32, maxPendingBytes: 1024 * 1024 },
  onFailure: ({ phase, error }) => {
    reportDaemonError(`Daemon ${phase} failed: ${getErrorMessage(error)}`);
    if (phase === 'progress' || stopping || storageRetry !== undefined) return;
    storageRetry = setTimeout(() => {
      storageRetry = undefined;
      void dispatcher.retryStorage().catch(reportDaemonError);
    }, 1000);
    storageRetry.unref();
  } });
  const input = createDaemonConversationInput({ ingress: dispatcher, async resolveAssignment(selected) {
    const assignment = await routing.resolve(selected);
    await conversations.ensure(assignment);
    return assignment;
  } });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    stopping = true; clearTimeout(storageRetry);
    input.stopAccepting(); ipc?.stopAccepting(); slack?.stopAccepting();
    closing ??= dispatcher.control({ kind: 'stop' }).then(() => undefined);
    return closing;
  };
  const stopDuringStartup = (): void => { void close().catch(reportDaemonError); };
  options.signal.addEventListener('abort', stopDuringStartup, { once: true });
  try {
    options.signal.throwIfAborted();
    await retireLegacyPatrols(directory);
    await conversations.ensure({ kind: 'daemon' });
    for (const assignment of await routing.assignments()) await conversations.ensure(assignment);
    await restoreLegacyConversations(conversations, eventStore);
    const restored = await eventStore.restore();
    options.signal.throwIfAborted();
    await dispatcher.restore(restored.lastAcceptedSequence, restored.pending);
    const global = await globalDaemonConfiguration(directory);
    const repositories: SlackRepositoryConfig[] = [];
    for (const route of await routing.routes()) {
      const assignment = routeAssignment(route);
      await conversations.ensure(assignment);
      const config = await readDaemonConfiguration(join(route.repositoryDirectory, '.takt', 'config.yaml'));
      if (config.manager?.slack === undefined) continue;
      repositories.push({ repositoryDirectory: route.repositoryDirectory, async resolveAssignment() {
        const current = await routing.resolve({ kind: 'repository', repositoryDirectory: route.repositoryDirectory });
        await conversations.ensure(current);
        const display = await routing.display(current);
        if (display.kind === 'daemon') throw new Error('Manager assignment required');
        return display;
      }, channelId: config.manager.slack.channel_id,
        allowedUserIds: config.manager.slack.allowed_user_ids, language: config.language ?? global.language ?? 'en' });
    }
    ipc = await createConversationIpcServer(directory, options.owner, input);
    options.signal.throwIfAborted();
    const files = new DaemonPersistedFiles(directory);
    const records = new FileWatchRecords(directory);
    watchers = startDaemonWatchers({ source: new FileDaemonWatchSource(conversations, (notice) => dispatcher.inquiry(notice), reportDaemonError,
      new WatchObservations(records, dispatcher, Date.now)),
      processes: new AsyncProcess(), commands: new AsyncCommand(), records, ingress: dispatcher,
      async filesChanged(change) {
        if (change.target.kind === 'inbox') await receiveInboxChange(change, files, conversations, dispatcher);
        else {
          for (const assignment of await routing.assignments()) await conversations.ensure(assignment);
          watchers?.changed();
        }
      }, now: Date.now, onError: (_target, error) => reportDaemonError(error) });
    slack = await createDaemonSlackPorts({ repositories, configDirectory: directory, input, tokens: options.tokens, signal: options.signal,
      director: { language: global.language ?? 'en', slack: global.director?.slack === undefined ? undefined
        : { channelId: global.director.slack.channel_id, allowedUserIds: global.director.slack.allowed_user_ids } } });
    resolveSlack(slack);
    options.signal.throwIfAborted();
    return { dispatcher, input, conversations, watchers, close };
  } catch (error) {
    resolveSlack(undefined);
    finishStartup();
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Daemon startup and cleanup failed'); }
    throw error;
  } finally { finishStartup(); options.signal.removeEventListener('abort', stopDuringStartup); }
}

export async function runDaemon(): Promise<void> {
  const directory = await resolveDaemonConfigDirectory(process.env.TAKT_CONFIG_DIR || join(homedir(), '.takt'));
  const io = { signal: new AbortController().signal, timeoutMs: 5000 };
  const identity = await readProcessOwner(process.pid, io);
  if (identity === undefined) throw new Error('Cannot identify daemon process');
  const content = await readPrivateFile(fileURLToPath(new URL('../../../package.json', import.meta.url)), 256 * 1024);
  if (content === undefined) throw new Error('Missing package metadata');
  const metadata = JSON.parse(content.toString('utf8')) as { version: string };
  const owner: DaemonOwner = { pid: process.pid, identity: { startTime: identity.startTime }, version: metadata.version,
    cliPath: fileURLToPath(new URL('../../app/daemon/index.js', import.meta.url)) };
  if (!await registerDaemonOwner(directory, owner, io)) return;
  const appToken = process.env.TAKT_SLACK_APP_TOKEN;
  const botToken = process.env.TAKT_SLACK_BOT_TOKEN;
  delete process.env.TAKT_SLACK_APP_TOKEN;
  delete process.env.TAKT_SLACK_BOT_TOKEN;
  const controller = new AbortController();
  const stopped = new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
  const stop = (): void => controller.abort();
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const logger = new DaemonLogger(directory);
  const restoreErrorLog = installDaemonErrorLog((message) => logger.write('error', message));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const failures: unknown[] = [];
  try {
    daemon = await startDaemon({ configDirectory: directory, owner, tokens: appToken && botToken ? { appToken, botToken } : undefined, signal: controller.signal });
    await logger.write('info', `Daemon started (${process.pid})`);
    await stopped;
  } catch (error) {
    if (error !== controller.signal.reason) { reportDaemonError(error); failures.push(error); }
  } finally {
    stop();
    try {
      await daemon?.close();
      await logger.write('info', `Daemon stopped (${process.pid})`);
    } catch (error) {
      reportDaemonError(error);
      failures.push(error);
    } finally {
      restoreErrorLog();
      try { await logger.close(); } catch (error) { failures.push(error); }
      try { await removeDaemonOwner(directory, owner, io); } catch (error) { failures.push(error); }
      process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Daemon execution and cleanup failed');
}
