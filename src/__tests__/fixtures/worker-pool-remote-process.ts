import { runRemoteWorker } from '../../features/workerPool/remoteWorker.js';
import { packageVersion } from '../../shared/package-info.js';
import { connectWorkerTransport } from '../../infra/worker-pool/remoteTransport.js';
import { workerTokenIdentity } from '../../infra/worker-pool/workerRegistry.js';
import { executionIdentity, type RemoteAssignment } from '../../core/worker-pool/remoteProtocol.js';
import { randomUUID } from 'node:crypto';

const controller = new AbortController();
const completions = new Map<string, (result: { success: boolean }) => void>();
const assignments = new Map<string, RemoteAssignment>();
const mode = process.argv[5];
let quit!: () => void;
const quitting = new Promise<void>((resolve) => { quit = resolve; });
process.on('message', (message: { kind: string; executionId?: string }) => {
  if (message.kind === 'quit') { for (const complete of completions.values()) complete({ success: false }); controller.abort(); quit(); }
  if (message.kind === 'complete' && message.executionId !== undefined) completions.get(message.executionId)?.({ success: true });
  if (message.kind === 'late-complete' && message.executionId !== undefined) {
    const assignment = assignments.get(message.executionId)!;
    process.send?.({ kind: 'late-sent', executionId: assignment.executionId, pid: process.pid });
    if (mode === 'late-expired') completions.get(message.executionId)?.({ success: true });
    else {
      const envelope = { protocolVersion: 1 as const, ...workerTokenIdentity(process.argv[3]!), requestId: randomUUID() };
      const transport = connectWorkerTransport({ url: new URL(process.argv[2]!), token: process.argv[3]!, onResponse(response) {
        process.send?.({ kind: 'late-result', response, executionId: assignment.executionId, pid: process.pid });
        transport.close();
      } });
      void transport.closed.catch(() => {});
      transport.send({ ...envelope, kind: 'connect', version: process.argv[4] ?? packageVersion, canExecute: true, active: [] });
      transport.send({ ...envelope, requestId: randomUUID(), kind: 'complete', assignment: executionIdentity(assignment), success: true });
    }
  }
});
try {
  await runRemoteWorker({ url: process.argv[2]!, token: process.argv[3]!, version: process.argv[4] ?? packageVersion,
    signal: controller.signal,
    onConnected(worker) { process.send?.({ kind: 'connected', worker, pid: process.pid }); },
    executor: { execute(assignment, signal) {
      assignments.set(assignment.executionId, assignment);
      process.send?.({ kind: 'started', assignment, pid: process.pid });
      return new Promise<{ success: boolean }>((resolve) => {
        completions.set(assignment.executionId, resolve);
        signal.addEventListener('abort', () => {
          process.send?.({ kind: 'stopped', executionId: assignment.executionId, pid: process.pid });
          if (mode !== 'late-expired') { completions.delete(assignment.executionId); resolve({ success: false }); }
        }, { once: true });
      });
    } },
  });
} catch (error) {
  process.send?.({ kind: 'rejected', reason: error instanceof Error ? error.message : 'Worker failed' });
  process.exitCode = 1;
} finally { if (mode === 'late-removed' && !controller.signal.aborted) await quitting; process.disconnect?.(); }
