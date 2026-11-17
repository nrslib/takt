export interface PoolWorker {
  name: string;
  kind: 'builtin' | 'remote';
  concurrency: number | undefined;
  registrationGeneration?: string;
}

export interface PoolProject {
  projectId: string;
  concurrency: number;
}

export interface PoolTask {
  projectId: string;
  taskName: string;
  mergeTask: boolean;
  origin?: string;
  retryWorker?: string;
  retryReady?: boolean;
  remoteOnly?: boolean;
}

export interface PoolAssignment {
  projectId: string;
  taskName: string;
  workerName: string;
  retryReservation?: boolean;
  registrationGeneration?: string;
}

export interface ProjectWork {
  concurrency: number;
  available: boolean;
  tasks: Omit<PoolTask, 'projectId'>[];
  remoteRecords?: import('./remoteProtocol.js').RemoteTaskRecord[];
}

export interface WorkerProject {
  inspect(): Promise<ProjectWork | ProjectClaimRetry>;
  setWaitingReasons(reasons: readonly PendingTaskReason[]): Promise<ProjectWaitingResult>;
  start(taskName: string, workerName: string): Promise<ProjectStartResult>;
  remote?(request: import('./remoteProtocol.js').RemoteProjectRequest): Promise<import('./remoteProtocol.js').RemoteProjectReply>;
  close(): Promise<void>;
}

export interface PendingTaskReason { taskName: string; reason?: string }

export interface ProjectClaimRetry { kind: 'claim_retry'; retryAt: number }
export type ProjectWaitingResult = { kind: 'updated' } | ProjectClaimRetry;

export type ProjectStartResult =
  | { kind: 'started' }
  | { kind: 'declined' }
  | ProjectClaimRetry
  | { kind: 'preparation_failed'; message: string };

export interface WorkerPullPort {
  pull(workerName: string): PoolAssignment | undefined;
  project(projectId: string): WorkerProject | undefined;
  decline(assignment: PoolAssignment, result: ProjectStartResult): void;
  hostFailed(projectId: string, error: unknown): Promise<void>;
}

export interface PoolWorkerAdapter {
  worker: PoolWorker;
  dispatch(port: WorkerPullPort): Promise<void>;
}
