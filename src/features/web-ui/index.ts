import type { Server } from 'node:http';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { launchWithNodeSpawn } from './launcher.js';
import { createWebUiServer, listenWebUiServer } from './server.js';
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
  });
}

export async function startWebUi(options: StartWebUiOptions): Promise<StartedWebUi> {
  const globalConfigDirectory = getGlobalConfigDir();
  const lock = await acquireWebUiInstanceLock(globalConfigDirectory, options.port);
  let server: Server | undefined;
  const close = () => server?.close();
  try {
    server = await createWebUiServer({
      globalConfigDirectory,
      launch: (projectDirectory, request, registeredProject) => launchWithNodeSpawn({
        projectDirectory,
        globalConfigDirectory,
        ...(registeredProject === undefined ? {} : { registeredProject }),
        request,
      }),
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
