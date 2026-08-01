import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBootstrapRecoverySeed } from '../../core/workflow/run/bootstrap-recovery-seed.js';
import { buildRunPaths } from '../../core/workflow/run/run-paths.js';
import type { RunStorageRoot } from '../../infra/run-storage/index.js';
import {
  createRunStorage,
  resumeRunStorage,
} from '../../infra/run-storage/root.js';
import { generateReportDir, isValidReportDirName } from '../../shared/utils/index.js';
import { RunMetaManager } from '../../features/tasks/execute/runMeta.js';
import type {
  WorkflowRunBootstrap,
  WorkflowRunHandle,
  WorkflowRunStorageComposition,
  WorkflowRunStorageCompositionInput,
} from '../../features/tasks/execute/workflowRunStorage.js';
import { projectWorkflowTerminalStage } from '../../features/tasks/execute/workflowTerminalProjection.js';
import { TEST_RUN_STORAGE_CLOCK } from './run-storage-clock.js';

const roots: string[] = [];
export function createWorkflowRunStorageCompositionTestDouble(
  createComposition: (
    input: WorkflowRunStorageCompositionInput,
  ) => WorkflowRunStorageComposition,
  input: WorkflowRunStorageCompositionInput,
  options: {
    readonly sessionId: string;
    readonly startedAt: string;
    readonly projectTerminalArtifacts: boolean;
  },
): WorkflowRunStorageComposition {
  const composition = createComposition(input);
  return {
    ...composition,
    storage: {
      beginRun: async (runInput): Promise<WorkflowRunHandle> => {
        const runSlug = runInput.requestedRunSlug
          ?? generateReportDir(runInput.task);
        if (!isValidReportDirName(runSlug)) {
          throw new Error(`Invalid reportDirName: ${runSlug}`);
        }
        const runPaths = buildRunPaths(input.cwd, runSlug);
        let runMetaManager: RunMetaManager | undefined;
        const bootstrap: WorkflowRunBootstrap = {
          backend: 'file',
          runSlug,
          runPaths,
          startedAt: options.startedAt,
          sessionId: options.sessionId,
          publishRunMeta: (metaInput) => {
            if (runMetaManager !== undefined) {
              return runMetaManager;
            }
            runMetaManager = new RunMetaManager(
              metaInput.runPaths,
              metaInput.task,
              metaInput.workflowName,
              'file',
              metaInput.resumeSource,
              metaInput.options,
            );
            return runMetaManager;
          },
        };
        return {
          runSlug,
          runPaths,
          bootstrap,
          finish: async (outcome, payload) => {
            if (runMetaManager === undefined) {
              throw new Error('Run meta projection is not bound');
            }
            runMetaManager.projectTerminal({
              status: payload.status,
              iterations: payload.iterations,
              ...(payload.reason === undefined
                ? {}
                : { reason: payload.reason }),
              endTime: payload.endTime,
            });
            if (options.projectTerminalArtifacts) {
              for (const stage of ['session', 'trace'] as const) {
                projectWorkflowTerminalStage(stage, payload, {
                  runPaths,
                  metaProjection: {
                    project: () => {},
                  },
                  publicationId: 'mock-publication',
                });
              }
            }
            const payloadSha256 = createHash('sha256')
              .update(JSON.stringify(payload))
              .digest('hex');
            return {
              receipt: {
                runId: runSlug,
                publicationId: `mock-file-terminal:${runSlug}:${payloadSha256}`,
                runStatus: outcome.status,
                iteration: outcome.iteration,
                payloadSha256,
                proof: { backend: 'file' },
              },
              issues: [],
            };
          },
          bindExecution: async () => ({
            findingAuthorityResolver: {
              resolve: () => {
                throw new Error('Mock engine must not resolve findings');
              },
            },
            execution: {
              run: async (operation) => operation(new AbortController()),
            },
          }),
        };
      },
    },
  };
}

export function createTestBootstrapSeed(input?: {
  readonly task?: string;
  readonly workflowName?: string;
  readonly projectCwd?: string;
  readonly sessionId?: string;
}) {
  return createBootstrapRecoverySeed({
    task: input?.task ?? 'test task',
    workflowName: input?.workflowName ?? 'default',
    projectCwd: input?.projectCwd ?? '/test/project',
    backend: 'sqlite',
    startedAt: '2026-07-27T09:00:00.000Z',
    sessionId: input?.sessionId ?? 'test-session',
  });
}

export function createRealRunStorage(options?: {
  readonly findingContractEnabled?: boolean;
  readonly busyRetryDelaysMs?: readonly number[];
  readonly wait?: (delayMs: number) => void;
}): {
  readonly databasePath: string;
  readonly root: RunStorageRoot;
  readonly clock: typeof TEST_RUN_STORAGE_CLOCK;
} {
  const directory = mkdtempSync(join(tmpdir(), 'takt-run-storage-'));
  roots.push(directory);
  const databasePath = join(directory, 'run.sqlite');
  const clock = TEST_RUN_STORAGE_CLOCK;
  clock.set(1_000);
  return {
    databasePath,
    clock,
    root: createRunStorage({
      databasePath,
      bootstrapSeed: createTestBootstrapSeed(),
      run: {
        runId: 'run-1',
        workflowName: 'default',
        findingContractEnabled: options?.findingContractEnabled === true,
      },
      busyRetry: {
        delaysMs: options?.busyRetryDelaysMs ?? [1, 2, 4],
        wait: options?.wait ?? (() => {}),
      },
    }),
  };
}

export function resumeRealRunStorage(
  source: RunStorageRoot,
  options?: {
    readonly slug?: string;
    readonly findingContractEnabled?: boolean;
    readonly busyRetryDelaysMs?: readonly number[];
    readonly wait?: (delayMs: number) => void;
  },
): {
  readonly databasePath: string;
  readonly root: RunStorageRoot;
  readonly clock: typeof TEST_RUN_STORAGE_CLOCK;
} {
  const directory = mkdtempSync(join(tmpdir(), 'takt-run-storage-resume-'));
  roots.push(directory);
  const databasePath = join(directory, 'run.sqlite');
  return {
    databasePath,
    clock: TEST_RUN_STORAGE_CLOCK,
    root: resumeRunStorage({
      databasePath,
      bootstrapSeed: createTestBootstrapSeed({
        sessionId: `${options?.slug ?? 'run-resume'}-session`,
      }),
      source,
      run: {
        runId: options?.slug ?? 'run-resume',
        workflowName: 'default',
        findingContractEnabled: options?.findingContractEnabled
          ?? source.readResumeSnapshot().run.findingContractEnabled === 1,
      },
      busyRetry: {
        delaysMs: options?.busyRetryDelaysMs ?? [1, 2, 4],
        wait: options?.wait ?? (() => {}),
      },
    }),
  };
}

export function cleanupRealRunStorages(): void {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}
