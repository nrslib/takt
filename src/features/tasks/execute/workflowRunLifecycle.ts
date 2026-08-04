import type { WorkflowConfig } from '../../../core/models/index.js';
import { mkdirSync } from 'node:fs';
import { generateSessionId } from '../../../infra/fs/index.js';
import { join } from 'node:path';
import type {
  FindingAuthorityResolver,
} from '../../../core/workflow/types.js';
import type { FindingLedgerStore } from '../../../core/workflow/findings/store.js';
import type { RunPaths } from '../../../core/workflow/run/run-paths.js';
import { buildRunPaths } from '../../../core/workflow/run/run-paths.js';
import type {
  RunResumeSource,
} from '../../../core/workflow/run/run-meta.js';
import { generateExecutionReportDir } from '../../../core/workflow/run/run-slug.js';
import {
  generateReportDir,
  isValidReportDirName,
} from '../../../shared/utils/index.js';
import {
  FindingStorageResolver,
  ROOT_FINDING_AUTHORITY_KEY,
} from '../../../infra/finding-storage/index.js';
import {
  RunMetaManager,
  type RunMetaManagerOptions,
} from './runMeta.js';
import {
  RunCleanupError,
  type WorkflowRunExecutionControl,
  type WorkflowRunExecutionHandle,
} from './workflowRunExecution.js';
import {
  createFileWorkflowRunTerminalPublisher,
} from './fileWorkflowRunTerminalPublisher.js';
import type {
  WorkflowTerminalPayloadFactory,
} from './workflowTerminalPayload.js';
import { resolveFindingStorageSource } from './findingStorageSource.js';
export interface WorkflowRunExecutionContext {
  readonly workflowConfig: WorkflowConfig;
  readonly runPaths: RunPaths;
  readonly resumeSource?: RunResumeSource;
  readonly terminalPayloads: WorkflowTerminalPayloadFactory;
}

export interface WorkflowRunLifecycleCompositionInput {
  readonly cwd: string;
}

export interface WorkflowRunBootstrap {
  readonly runSlug: string;
  readonly runPaths: RunPaths;
  readonly startedAt: string;
  readonly sessionId: string;
  publishRunMeta(input: {
    readonly runPaths: RunPaths;
    readonly task: string;
    readonly workflowName: string;
    readonly resumeSource?: RunResumeSource;
    readonly options?: RunMetaManagerOptions;
  }): RunMetaManager;
}

export interface WorkflowRunExecutionBinding {
  readonly execution: Pick<WorkflowRunExecutionHandle, 'run'>;
  readonly findingAuthorityResolver: FindingAuthorityResolver;
}

export interface WorkflowRunHandle {
  readonly runSlug: string;
  readonly runPaths: RunPaths;
  readonly bootstrap: WorkflowRunBootstrap;
  bindExecution(
    context: Omit<WorkflowRunExecutionContext, 'runPaths'>,
  ): Promise<WorkflowRunExecutionBinding>;
  finish: WorkflowRunExecutionHandle['finish'];
}

export interface WorkflowRunLifecycleComposition {
  readonly lifecycle: WorkflowRunLifecyclePort;
}

export interface WorkflowRunLifecyclePort {
  beginRun(input: {
    readonly workflowConfig: WorkflowConfig;
    readonly task: string;
    readonly requestedRunSlug?: string;
    readonly resumeSource?: RunResumeSource;
  }): Promise<WorkflowRunHandle>;
}

export function createWorkflowRunLifecycle(
  input: WorkflowRunLifecycleCompositionInput,
): WorkflowRunLifecycleComposition {
  const lifecycle = new WorkflowRunLifecycleAdapter(input);
  return Object.freeze({
    lifecycle: Object.freeze({
      beginRun: (
        runInput: Parameters<WorkflowRunLifecyclePort['beginRun']>[0],
      ) => {
        const startedAt = new Date().toISOString();
        return lifecycle.beginRun({
          ...runInput,
          startedAt,
          sessionId: generateSessionId(),
        });
      },
    }),
  });
}

class WorkflowRunLifecycleAdapter {
  readonly #cwd: string;

  constructor(input: WorkflowRunLifecycleCompositionInput) {
    this.#cwd = input.cwd;
  }

  async beginRun(input: {
    readonly workflowConfig: WorkflowConfig;
    readonly task: string;
    readonly requestedRunSlug?: string;
    readonly resumeSource?: RunResumeSource;
    readonly startedAt: string;
    readonly sessionId: string;
  }): Promise<WorkflowRunHandle> {
    const initialRunSlug = this.resolveRunSlug({
      task: input.task,
      ...(input.requestedRunSlug === undefined
        ? {}
        : { requestedRunSlug: input.requestedRunSlug }),
      ...(input.resumeSource === undefined
        ? {}
        : { resumeSource: input.resumeSource }),
    });
    const runPaths = this.reserveRunDirectory({
      initialRunSlug,
      task: input.task,
      requestedRunSlug: input.requestedRunSlug,
    });
    const abortController = new AbortController();
    const terminalPublisher = createFileWorkflowRunTerminalPublisher({
      runPaths,
    });
    let runMetaManager: RunMetaManager | undefined;
    let findingStorage: FindingStorageResolver | undefined;
    let bound = false;
    let finished = false;

    const finish: WorkflowRunExecutionHandle['finish'] = async (
      outcome,
      payload,
    ) => {
      if (finished) {
        throw new Error(`Workflow run "${runPaths.slug}" is already finished`);
      }
      finished = true;
      let committed: Awaited<ReturnType<typeof terminalPublisher.finish>>
        | undefined;
      let publicationError: unknown;
      try {
        committed = await terminalPublisher.finish(outcome, payload);
      } catch (error) {
        publicationError = error;
      }
      const cleanupIssues: RunCleanupError[] = [];
      try {
        findingStorage?.close();
      } catch (error) {
        cleanupIssues.push(new RunCleanupError(error));
      }
      if (publicationError !== undefined) {
        throw combineErrors(publicationError, cleanupIssues);
      }
      if (committed === undefined) {
        throw new Error('File terminal commit receipt is missing');
      }
      return Object.freeze({
        receipt: committed.receipt,
        issues: Object.freeze([
          ...committed.issues,
          ...cleanupIssues,
        ]),
      });
    };

    return Object.freeze({
      runSlug: runPaths.slug,
      runPaths,
      bootstrap: Object.freeze({
        runSlug: runPaths.slug,
        runPaths,
        startedAt: input.startedAt,
        sessionId: input.sessionId,
        publishRunMeta: (
          metaInput: Parameters<
            WorkflowRunBootstrap['publishRunMeta']
          >[0],
        ) => {
          assertRunPathsIdentity(metaInput.runPaths, runPaths);
          if (runMetaManager !== undefined) {
            return runMetaManager;
          }
          const manager = new RunMetaManager(
            metaInput.runPaths,
            metaInput.task,
            metaInput.workflowName,
            metaInput.resumeSource,
            {
              ...metaInput.options,
              startTime: input.startedAt,
            },
          );
          runMetaManager = manager;
          return manager;
        },
      }),
      bindExecution: async (
        _context: Omit<WorkflowRunExecutionContext, 'runPaths'>,
      ) => {
        if (bound) {
          throw new Error(
            `Workflow run "${runPaths.slug}" is already bound`,
          );
        }
        bound = true;
        const executionControl = createWorkflowRunExecutionControl(
          abortController,
        );
        const getFindingStorage = (): FindingStorageResolver => {
          if (finished) {
            throw new Error(`Workflow run "${runPaths.slug}" is already finished`);
          }
          if (findingStorage === undefined) {
            findingStorage = createFindingStorageResolver({
              runPaths,
              cwd: this.#cwd,
              ...(input.resumeSource === undefined
                ? {}
                : { resumeSource: input.resumeSource }),
            });
          }
          return findingStorage;
        };
        const findingAuthorityResolver = createFindingAuthorityResolver(
          getFindingStorage,
        );
        return {
          findingAuthorityResolver,
          execution: {
            run: async <T>(
              operation: (
                control: WorkflowRunExecutionControl,
              ) => Promise<T>,
            ): Promise<T> => operation(executionControl),
          },
        };
      },
      finish,
    });
  }

  private resolveRunSlug(input: {
    readonly task: string;
    readonly requestedRunSlug?: string;
    readonly resumeSource?: RunResumeSource;
  }): string {
    const runSlug = requireValidRunSlug(
      input.requestedRunSlug
        ?? (input.resumeSource?.sourceRunSlug === undefined
          ? generateReportDir(input.task)
          : generateExecutionReportDir(this.#cwd, input.task)),
    );
    if (input.resumeSource?.sourceRunSlug === runSlug) {
      throw new Error(
        `Workflow resume requires distinct source and target run slugs: "${runSlug}"`,
      );
    }
    return runSlug;
  }

  private reserveRunDirectory(input: {
    readonly initialRunSlug: string;
    readonly task: string;
    readonly requestedRunSlug?: string;
  }): RunPaths {
    mkdirSync(join(this.#cwd, '.takt', 'runs'), { recursive: true });
    let runSlug = input.initialRunSlug;
    while (true) {
      const runPaths = buildRunPaths(this.#cwd, runSlug);
      try {
        mkdirSync(runPaths.runRootAbs);
        return runPaths;
      } catch (error) {
        if (!isFileSystemErrorWithCode(error, 'EEXIST')) {
          throw error;
        }
        if (input.requestedRunSlug !== undefined) {
          throw new Error(`Run directory already exists: ${runPaths.runRootAbs}`);
        }
        runSlug = generateExecutionReportDir(this.#cwd, input.task);
      }
    }
  }
}

function createFindingStorageResolver(input: {
  readonly runPaths: RunPaths;
  readonly resumeSource?: RunResumeSource;
  readonly cwd: string;
}): FindingStorageResolver {
  const source = resolveFindingStorageSource(input.cwd, input.resumeSource);
  return new FindingStorageResolver({
    databasePath: input.runPaths.findingContractDatabaseAbs,
    runId: input.runPaths.slug,
    ...(source === undefined ? {} : { source }),
  });
}

function createFindingAuthorityResolver(
  getStorage: () => FindingStorageResolver,
): FindingAuthorityResolver {
  const stores = new Map<string, FindingLedgerStore>();
  return {
    resolve({
      workflowConfig,
      runPaths,
      workflowCallSiteIdentity,
    }): FindingLedgerStore {
      if (workflowConfig.findingContract === undefined) {
        throw new Error(
          `Finding authority requested for workflow `
          + `"${workflowConfig.name}" without Finding Contract`,
        );
      }
      const authorityKey = workflowCallSiteIdentity
        ?? ROOT_FINDING_AUTHORITY_KEY;
      const existing = stores.get(authorityKey);
      if (existing !== undefined) {
        return existing;
      }
      const storage = getStorage();
      const store = storage.resolveAuthority({
        authorityKey,
        workflowName: workflowConfig.name,
        reportDir: runPaths.reportsAbs,
      });
      stores.set(authorityKey, store);
      return store;
    },
  };
}

function requireValidRunSlug(runSlug: string): string {
  if (!isValidReportDirName(runSlug)) {
    throw new Error(`Invalid reportDirName: ${runSlug}`);
  }
  return runSlug;
}

function isFileSystemErrorWithCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error
    && 'code' in error
    && error.code === code;
}

function createWorkflowRunExecutionControl(
  abortController: AbortController,
): WorkflowRunExecutionControl {
  return Object.freeze({
    signal: abortController.signal,
    abort(reason?: unknown): void {
      abortController.abort(reason);
    },
  });
}

function assertRunPathsIdentity(
  actual: RunPaths,
  reserved: RunPaths,
): void {
  if (
    actual.slug !== reserved.slug
    || actual.runRootAbs !== reserved.runRootAbs
  ) {
    throw new Error(
      `Run metadata paths do not match reserved run "${reserved.slug}"`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function combineErrors(
  primaryError: unknown,
  additionalErrors: readonly unknown[],
): unknown {
  if (additionalErrors.length === 0) {
    return primaryError;
  }
  return new AggregateError(
    [primaryError, ...additionalErrors],
    errorMessage(primaryError),
    { cause: primaryError },
  );
}
