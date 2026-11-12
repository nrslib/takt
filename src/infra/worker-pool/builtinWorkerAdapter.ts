import type { PoolWorker, PoolWorkerAdapter, WorkerPullPort } from '../../core/worker-pool/types.js';

export class BuiltinWorkerAdapter implements PoolWorkerAdapter {
  constructor(readonly worker: PoolWorker) {}

  async dispatch(port: WorkerPullPort): Promise<void> {
    for (let assignment; (assignment = port.pull(this.worker.name)) !== undefined;) {
      try {
        const project = port.project(assignment.projectId);
        const result = await project?.start(assignment.taskName, assignment.workerName);
        if (result?.kind !== 'started') port.decline(assignment, result ?? { kind: 'declined' });
      } catch (error) {
        await port.hostFailed(assignment.projectId, error);
      }
    }
  }
}
