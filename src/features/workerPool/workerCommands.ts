import { WorkerRegistry } from '../../infra/worker-pool/workerRegistry.js';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';
import { packageVersion } from '../../shared/package-info.js';
import { runRemoteWorker } from './remoteWorker.js';

export async function addWorker(name: string, concurrency: number): Promise<void> {
  const { token } = await new WorkerRegistry(getGlobalConfigDir()).add(name, concurrency);
  process.stdout.write(`${token}\n`);
}

export async function listWorkers(): Promise<void> {
  for (const worker of await new WorkerRegistry(getGlobalConfigDir()).list()) {
    process.stdout.write(`${sanitizeTerminalText(worker.name)}\t${worker.concurrency}\n`);
  }
}

export async function removeWorker(name: string): Promise<void> {
  await new WorkerRegistry(getGlobalConfigDir()).remove(name);
}

export async function startWorker(url: string, token: string): Promise<void> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.on('SIGTERM', abort); process.on('SIGINT', abort);
  try {
    await runRemoteWorker({ url, token, version: packageVersion, signal: controller.signal,
      onConnected(identity) { process.stdout.write(`Worker ${sanitizeTerminalText(identity.workerId)} connected\n`); },
    });
  } finally { process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort); }
}
