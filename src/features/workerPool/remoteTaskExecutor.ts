import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { remoteFilePath } from '../../infra/task/remoteExecutionStore.js';
import { REMOTE_CHUNK_BYTES, RemoteExecutionResultFields, RemoteInterventionDeliverySchema, RemoteControlSchema } from '../../core/worker-pool/remoteExecutionProtocol.js';
import type { RemoteTaskExecutor } from './remoteWorker.js';
import { RemoteRunSender } from './remoteRunSender.js';
import { RemoteExecutionInputSchema } from './remoteExecutionInput.js';
import { spawnManagedProcess } from '../../shared/utils/spawn.js';
import { envVarNameFromPath } from '../../infra/config/env/config-env-overrides.js';
import { applyRemoteOpenCodeEnvironment } from './remoteExecutionEnvironment.js';
import { createSensitiveTextStreamRedactor } from '../../shared/utils/sensitiveText.js';
import { sanitizeRemoteFailureReason } from '../../core/worker-pool/remoteFailure.js';

const resultSchema = z.object({ kind: z.literal('result'), success: z.boolean(), reason: z.string().optional(),
  ...RemoteExecutionResultFields,
  sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional() }).strict();
const appliedSchema = z.object({ kind: z.literal('control-applied'), sequence: z.number().int().nonnegative() }).strict();
const deliverySchema = RemoteInterventionDeliverySchema.extend({ kind: z.literal('intervention-delivered') }).strict();

export function createRemoteTaskExecutor(environment: NodeJS.ProcessEnv): RemoteTaskExecutor {
  const childEnvironment = { ...environment };
  for (const provider of ['codex', 'claude', 'cursor', 'copilot', 'kiro', 'devin']) {
    delete childEnvironment[envVarNameFromPath(`${provider}_cli_path`)];
  }
  const workspace = (id: string): string => join(getGlobalConfigDir(), 'worker-executions', z.string().uuid().parse(id));
  return { async workspace(assignment, operation) {
    const root = workspace(assignment.workLocation ?? assignment.executionId);
    if (operation === 'remove') {
      await rm(root, { recursive: true, force: true });
      return false;
    }
    try { return (await lstat(join(root, 'clone', '.git'))).isDirectory(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }, async execute(assignment, signal, port) {
    const root = assignment.workLocation === null ? workspace(assignment.executionId)
      : join(workspace(assignment.workLocation), 'attempts', assignment.executionId);
    const inputDirectory = join(root, 'input');
    const cloneDirectory = join(assignment.workLocation === null ? root : workspace(assignment.workLocation), 'clone');
    const controlDirectory = join(root, 'control');
    const temporaryDirectory = join(root, 'tmp');
    const manifestResponse = await port.request({ kind: 'input-manifest' });
    if (manifestResponse.kind !== 'input-manifest') throw new Error('Remote input manifest response is missing');
    const manifest = manifestResponse.manifest;
    if (manifest.runSlug !== `remote-${assignment.executionId}`) throw new Error('Remote input run does not match the assignment');
    await mkdir(inputDirectory, { recursive: true, mode: 0o700 });
    await mkdir(controlDirectory, { recursive: true, mode: 0o700 });
    await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    for (const directory of manifest.directories) await remoteFilePath(inputDirectory, `${directory}/.directory-check`);
    for (const entry of manifest.files) {
      signal.throwIfAborted();
      const path = await remoteFilePath(inputDirectory, entry.path);
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const hash = createHash('sha256');
        let offset = 0;
        while (offset < entry.size) {
          const response = await port.request({ kind: 'input-chunk', path: entry.path, offset });
          if (response.kind !== 'input-chunk') throw new Error('Remote input chunk response is missing');
          const bytes = Buffer.from(response.data, 'base64');
          if (bytes.length !== Math.min(REMOTE_CHUNK_BYTES, entry.size - offset)) throw new Error('Remote input chunk length does not match');
          hash.update(bytes); await file.writeFile(bytes); offset += bytes.length;
        }
        if (hash.digest('hex') !== entry.sha256) throw new Error('Remote input file hash does not match');
        await file.sync();
      } finally { await file.close(); }
    }
    const input = RemoteExecutionInputSchema.parse(JSON.parse(await readFile(join(inputDirectory, 'execution.json'), 'utf8')) as unknown);
    const credentials = await port.request({ kind: 'credentials' });
    if (credentials.kind !== 'credentials') throw new Error('Remote credentials response is missing');
    if (credentials.error !== undefined) throw new Error(credentials.error);
    const secretSource = { credentials: credentials.environment };
    const executionEnvironment = { ...applyRemoteOpenCodeEnvironment(childEnvironment, input.openCode), ...credentials.environment,
      TAKT_REMOTE_CREDENTIAL_NAMES: JSON.stringify(Object.keys(credentials.environment)),
      TAKT_REMOTE_GIT_ORIGIN: assignment.origin };
    signal.throwIfAborted();
    const entrypoint = new URL(import.meta.url.endsWith('.ts') ? './remoteTaskProcess.ts' : './remoteTaskProcess.js', import.meta.url);
    const managed = spawnManagedProcess(process.execPath, [...process.execArgv, fileURLToPath(entrypoint)], {
      cwd: root, env: { ...executionEnvironment, TMPDIR: temporaryDirectory, TMP: temporaryDirectory, TEMP: temporaryDirectory },
      shell: false, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }, undefined);
    const child = managed.child;
    let failureOutput = '';
    const redactor = createSensitiveTextStreamRedactor();
    child.stderr?.on('data', (bytes: Buffer) => { failureOutput = (failureOutput + redactor.write(bytes.toString('utf8'), secretSource)).slice(-8192); });
    child.stderr?.once('end', () => { failureOutput = (failureOutput + redactor.flush(secretSource)).slice(-8192); });
    let acknowledgedControl = 0;
    let partialControl: { sequence: number; offset: number; size: number; sha256: string; chunks: Buffer[] } | undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let replication: Promise<void> = Promise.resolve();
    let deliveries: Promise<void> = Promise.resolve();
    const sender = new RemoteRunSender(join(cloneDirectory, '.takt', 'runs', manifest.runSlug), manifest.runSlug, port);
    const abort = (): void => {
      if (child.connected) child.send({ kind: 'stop' });
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    };
    const result = new Promise<z.infer<typeof resultSchema>>((resolve, reject) => {
      child.on('message', (message: unknown) => {
        const applied = appliedSchema.safeParse(message);
        if (applied.success) {
          acknowledgedControl = applied.data.sequence;
          if (partialControl !== undefined && partialControl.sequence <= acknowledgedControl) partialControl = undefined;
          return;
        }
        const delivered = deliverySchema.safeParse(message);
        if (delivered.success) {
          deliveries = deliveries.then(async () => {
            const response = await port.request({ kind: 'intervention-delivery', instructionIds: delivered.data.instructionIds, context: delivered.data.context });
            if (response.kind !== 'intervention-delivery') throw new Error('Remote instruction delivery acknowledgement is missing');
          });
          void deliveries.catch(() => { if (!stopped) abort(); });
          return;
        }
        const result = resultSchema.safeParse(message);
        if (result.success) { stopped = true; clearTimeout(timer); resolve(result.data); }
        else reject(new Error('Remote task process returned an invalid result'));
      });
      child.once('error', reject);
      child.once('exit', (code, exitSignal) => { stopped = true; clearTimeout(timer);
        reject(new Error(`Remote task process exited (${exitSignal ?? code}): ${failureOutput}`)); });
    });
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
    const replicate = async (): Promise<void> => {
      await sender.flush();
      const response = await port.request({ kind: 'controls', acknowledgedSequence: acknowledgedControl,
        contentSequence: partialControl?.sequence, contentOffset: partialControl?.offset });
      if (response.kind !== 'controls') throw new Error('Remote controls response is missing');
      if (!stopped && child.connected) for (const control of response.controls) {
        if (control.sequence <= acknowledgedControl) continue;
        const chunk = control.contentChunk;
        if (chunk === undefined) { child.send({ kind: 'control', control }); continue; }
        if (partialControl?.sequence !== control.sequence) {
          if (chunk.offset !== 0) throw new Error('Remote instruction is missing its first chunk');
          partialControl = { sequence: control.sequence, offset: 0, size: chunk.size, sha256: chunk.sha256, chunks: [] };
        }
        const data = Buffer.from(chunk.data, 'base64');
        if (chunk.offset !== partialControl.offset || chunk.size !== partialControl.size || chunk.sha256 !== partialControl.sha256
          || data.length !== Math.min(REMOTE_CHUNK_BYTES, chunk.size - chunk.offset)) throw new Error('Remote instruction chunk does not match');
        partialControl.chunks.push(data); partialControl.offset += data.length;
        if (partialControl.offset === partialControl.size) {
          const content = Buffer.concat(partialControl.chunks);
          if (createHash('sha256').update(content).digest('hex') !== partialControl.sha256) throw new Error('Remote instruction hash does not match');
          const decoded = new TextDecoder('utf8', { fatal: true }).decode(content);
          child.send({ kind: 'control', control: RemoteControlSchema.parse({ ...control, contentChunk: undefined, content: decoded }) });
          partialControl = undefined;
        }
      }
    };
    const tick = (): void => {
      replication = replicate().then(() => { if (!stopped) timer = setTimeout(tick, 500); });
      void replication.catch(() => { if (!stopped) abort(); });
    };
    signal.addEventListener('abort', abort, { once: true });
    child.send({ kind: 'start', assignment, inputDirectory, cloneDirectory, controlDirectory });
    timer = setTimeout(tick, 500);
    try {
      const completed = await result;
      await deliveries;
      await replication;
      const finalLogSequence = await sender.flush();
      await port.request({ kind: 'controls', acknowledgedSequence: acknowledgedControl });
      return { success: completed.success, reason: completed.reason === undefined ? undefined : sanitizeRemoteFailureReason(assignment.workerName, completed.reason, Object.values(credentials.environment)), interrupted: completed.interrupted,
        retryable: completed.retryable, workflowResult: completed.workflowResult,
        prUrl: completed.prUrl, prFailed: completed.prFailed, prError: completed.prError === undefined ? undefined : sanitizeRemoteFailureReason(assignment.workerName, completed.prError, Object.values(credentials.environment)),
        ...(completed.sha === undefined ? {} : { artifacts: { branch: assignment.branch, sha: completed.sha,
          runSlug: manifest.runSlug, finalLogSequence } }) };
    } finally {
      stopped = true; clearTimeout(timer); clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
      if (child.connected) child.send({ kind: 'stop' });
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(killTimer);
      await managed.terminate();
    }
  } };
}
