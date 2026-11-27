import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { rm } from 'node:fs/promises';
import { z } from 'zod/v4';
import { WorkerIdentitySchema, WorkerRegistrationSchema, WorkerRejectedError, type WorkerIdentity, type WorkerRegistration } from '../../core/worker-pool/remoteProtocol.js';
import { FileAsyncLock } from '../daemon/lock.js';
import { readPrivateFile, writePrivateFile } from '../daemon/privateFile.js';

const registrationsSchema = z.array(WorkerRegistrationSchema);
const REGISTRY_FILE = 'workers.json';
export const WORKER_PULL_RESPONSES_DIRECTORY = 'worker-pull-responses';

export function workerTokenIdentity(token: string): WorkerIdentity {
  try {
    const [header, secret, extra] = token.split('.');
    if (!header || !secret || extra !== undefined) throw new Error('Invalid token');
    return WorkerIdentitySchema.parse(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as unknown);
  } catch { throw new WorkerRejectedError('Worker token is not registered or was removed'); }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class WorkerRegistry {
  private readonly path: string;
  private readonly lock = new FileAsyncLock();

  constructor(directory: string) { this.path = join(directory, REGISTRY_FILE); }

  private async read(): Promise<WorkerRegistration[]> {
    const bytes = await readPrivateFile(this.path, 1024 * 1024);
    return bytes === undefined ? [] : registrationsSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    return this.lock.exclusive(`${this.path}.lock`, action, { signal: new AbortController().signal, timeoutMs: 30_000 });
  }

  list(): Promise<WorkerRegistration[]> { return this.exclusive(() => this.read()); }

  add(name: string, concurrency: number): Promise<{ registration: WorkerRegistration; token: string }> {
    return this.exclusive(async () => {
      const registrations = await this.read();
      if (name === 'builtin') throw new Error('The worker name builtin is reserved');
      if (registrations.some((worker) => worker.name === name)) throw new Error('Worker name is already registered');
      const identity = WorkerIdentitySchema.parse({ workerId: name, registrationGeneration: randomUUID() });
      const header = Buffer.from(JSON.stringify(identity)).toString('base64url');
      const token = `${header}.${randomBytes(32).toString('base64url')}`;
      const registration = WorkerRegistrationSchema.parse({ name, registrationGeneration: identity.registrationGeneration,
        concurrency, tokenHash: tokenHash(token) });
      await writePrivateFile(this.path, JSON.stringify([...registrations, registration]));
      return { registration, token };
    });
  }

  remove(name: string): Promise<void> {
    return this.exclusive(async () => {
      const registrations = await this.read();
      const removed = registrations.find((worker) => worker.name === name);
      if (removed === undefined) throw new Error('Worker is not registered');
      await writePrivateFile(this.path, JSON.stringify(registrations.filter((worker) => worker.name !== name)));
      await rm(join(dirname(this.path), WORKER_PULL_RESPONSES_DIRECTORY, removed.registrationGeneration), { recursive: true, force: true });
    });
  }

  authorize<T>(token: string, action: (registration: WorkerRegistration) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const identity = workerTokenIdentity(token);
      const registration = (await this.read()).find((worker) => worker.name === identity.workerId
        && worker.registrationGeneration === identity.registrationGeneration);
      const hash = tokenHash(token);
      if (registration === undefined || !timingSafeEqual(Buffer.from(registration.tokenHash, 'hex'), Buffer.from(hash, 'hex'))) {
        throw new WorkerRejectedError('Worker token is not registered or was removed');
      }
      return action(registration);
    });
  }
}
