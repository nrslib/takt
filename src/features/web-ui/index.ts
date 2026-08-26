import type { Server } from 'node:http';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import {
  executeCentralTaskActionWithNodeSpawn,
  launchWithNodeSpawn,
  requeueWithNodeSpawn,
  startCentralTaskActionConversation,
} from './launcher.js';
import { createWebUiServer, listenWebUiServer } from './server.js';
import { createWebChatService } from './chat.js';
import {
  acquireWebUiInstanceLock,
  stopWebUiInstance,
  WebUiAlreadyRunningError,
  type StopWebUiResult,
  type WebUiInstance,
} from './instance-lock.js';

export interface StartWebUiOptions {
  readonly port: number;
}

export interface StartedWebUi {
  readonly origin: string;
  readonly server: Server;
}

export type OpenedWebUi =
  | { readonly disposition: 'started'; readonly origin: string; readonly server: Server }
  | { readonly disposition: 'existing'; readonly instance: WebUiInstance };

function closeWebUiServer(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise();
    });
    // EventSource keeps HTTP connections open indefinitely. Stop accepting new
    // connections first, then close active UI streams so restart can complete.
    server.closeAllConnections();
  });
}

export async function startWebUi(options: StartWebUiOptions): Promise<StartedWebUi> {
  const globalConfigDirectory = getGlobalConfigDir();
  const lock = await acquireWebUiInstanceLock(globalConfigDirectory, options.port);
  let server: Server | undefined;
  const chat = createWebChatService();
  const close = () => {
    void closeWebUiServer(server).catch(() => undefined);
  };
  try {
    server = await createWebUiServer({
      globalConfigDirectory,
      launch: (projectDirectory, request, registeredProject) => launchWithNodeSpawn({
        projectDirectory,
        globalConfigDirectory,
        ...(registeredProject === undefined ? {} : { registeredProject }),
        request,
      }),
      requeue: (projectDirectory, taskId, registeredProject) => requeueWithNodeSpawn({
        projectDirectory,
        globalConfigDirectory,
        ...(registeredProject === undefined ? {} : { registeredProject }),
        taskId,
      }),
      taskAction: (projectDirectory, taskId, action, input, conversationId, registeredProject, taskActionClaim) =>
        executeCentralTaskActionWithNodeSpawn({
          projectDirectory,
          globalConfigDirectory,
          ...(registeredProject === undefined ? {} : { registeredProject }),
          taskId,
          action,
          ...(input === undefined ? {} : { input }),
          ...(conversationId === undefined ? {} : { conversationId }),
          ...(taskActionClaim === undefined ? {} : { taskActionClaim }),
        }),
      taskActionConversation: (projectDirectory, taskId, action, registeredProject) =>
        startCentralTaskActionConversation({
          projectDirectory,
          globalConfigDirectory,
          ...(registeredProject === undefined ? {} : { registeredProject }),
          taskId,
          action,
          chat,
        }),
      chat,
      control: {
        token: lock.controlToken,
        onStopRequested: close,
      },
    });
    server.once('close', () => {
      void lock.release().catch(() => undefined);
    });
    const origin = await listenWebUiServer(server, options.port);
    await lock.publishOrigin(origin);

    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    server.once('close', () => {
      process.off('SIGINT', close);
      process.off('SIGTERM', close);
    });

    return { origin, server };
  } catch (error) {
    await closeWebUiServer(server);
    await lock.release();
    throw error;
  }
}

export async function openWebUi(options: StartWebUiOptions): Promise<OpenedWebUi> {
  try {
    const started = await startWebUi(options);
    return { disposition: 'started', ...started };
  } catch (error) {
    if (!(error instanceof WebUiAlreadyRunningError)) throw error;
    return { disposition: 'existing', instance: error.instance };
  }
}

export async function stopWebUi(): Promise<StopWebUiResult> {
  return stopWebUiInstance(getGlobalConfigDir());
}

export async function restartWebUi(options: StartWebUiOptions): Promise<StartedWebUi> {
  await stopWebUi();
  return startWebUi(options);
}
