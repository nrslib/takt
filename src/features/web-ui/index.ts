import type { Server } from 'node:http';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { launchWithNodeSpawn } from './launcher.js';
import { createWebUiServer, listenWebUiServer } from './server.js';
import { acquireWebUiInstanceLock } from './instance-lock.js';

export interface StartWebUiOptions {
  readonly port: number;
}

export interface StartedWebUi {
  readonly origin: string;
  readonly server: Server;
}

export async function startWebUi(options: StartWebUiOptions): Promise<StartedWebUi> {
  const globalConfigDirectory = getGlobalConfigDir();
  const lock = await acquireWebUiInstanceLock(globalConfigDirectory, options.port);
  let server: Server | undefined;
  try {
    server = await createWebUiServer({
      globalConfigDirectory,
      launch: (projectDirectory, request, registeredProject) => launchWithNodeSpawn({
        projectDirectory,
        globalConfigDirectory,
        ...(registeredProject === undefined ? {} : { registeredProject }),
        request,
      }),
    });
    server.once('close', () => void lock.release());
    const origin = await listenWebUiServer(server, options.port);

    const close = () => server?.close();
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    server.once('close', () => {
      process.off('SIGINT', close);
      process.off('SIGTERM', close);
    });

    return { origin, server };
  } catch (error) {
    server?.close();
    await lock.release();
    throw error;
  }
}
