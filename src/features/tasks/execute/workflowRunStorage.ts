import type { WorkflowConfig } from '../../../core/models/index.js';
import {
  existsSync,
  readdirSync,
} from 'node:fs';
import { generateSessionId } from '../../../infra/fs/index.js';
import { createSessionLog } from '../../../infra/fs/index.js';
import { join } from 'node:path';
import type { RunStorageBackend } from '../../../core/models/config-types.js';
import type {
  FindingAuthorityResolver,
} from '../../../core/workflow/types.js';
import type { FindingLedgerStore } from '../../../core/workflow/findings/store.js';
import { createFindingLedgerStore } from '../../../core/workflow/findings/store.js';
import type { RunPaths } from '../../../core/workflow/run/run-paths.js';
import { buildRunPaths } from '../../../core/workflow/run/run-paths.js';
import {
  readRunMeta,
  type RunMeta,
  type RunResumeSource,
} from '../../../core/workflow/run/run-meta.js';
import { generateExecutionReportDir } from '../../../core/workflow/run/run-slug.js';
import {
  generateReportDir,
  isValidReportDirName,
} from '../../../shared/utils/index.js';
import {
  createRunStorage,
  resumeRunStorage,
  type RunStorageRoot,
} from '../../../infra/run-storage/index.js';
import {
  openRunStorageResumeSource,
  openRunStorageTerminalRecovery,
} from '../../../infra/run-storage/root.js';
import {
  SqliteWorkflowRunStorageLifecycle,
} from './sqliteWorkflowRunStorageLifecycle.js';
import {
  RunMetaManager,
  type RunMetaManagerOptions,
} from './runMeta.js';
import type {
  WorkflowRunTerminalStatus,
} from './workflowTerminalStatus.js';
import {
  WorkflowRunExecutionControlError,
  type WorkflowRunExecutionControl,
  type WorkflowRunExecutionHandle,
} from './workflowRunExecution.js';
import {
  createFileWorkflowRunTerminalPublisher,
} from './fileWorkflowRunTerminalPublisher.js';
import {
  recoverWorkflowTerminalPublication,
  reconcileWorkflowTerminalPublication,
} from './workflowTerminalPublication.js';
import {
  createWorkflowTerminalPayloadFactory,
  deserializeWorkflowTerminalPublication,
  serializeWorkflowTerminalPublication,
  type WorkflowTerminalPayloadFactory,
  type WorkflowTerminalPublicationPayload,
} from './workflowTerminalPayload.js';
import {
  createFileTaskRunForceFailStorage,
  createSqliteTaskRunForceFailStorage,
} from './workflowRunForceFailAdapters.js';
import type {
  WorkflowRunForceFailContext,
  WorkflowRunForceFailHandle,
} from './workflowRunAdmin.js';
import {
  createBootstrapRecoverySeed,
  type BootstrapRecoverySeed,
} from '../../../core/workflow/run/bootstrap-recovery-seed.js';

const LEASE_DURATION_MS = 30_000;

/**
 * RunStorage requires an ExecutionHandle before it can construct a Finding
 * manager. Piece executions are not part of this composition boundary yet, so
 * this named domain execution represents the complete top-level workflow run;
 * it must not be interpreted as a piece execution.
 */
export const TOP_LEVEL_WORKFLOW_EXECUTION_STEP_KEY =
  'takt.top-level-workflow';

export interface WorkflowRunExecutionContext {
  readonly workflowConfig: WorkflowConfig;
  readonly runPaths: RunPaths;
  readonly resumeSource?: RunResumeSource;
  readonly terminalPayloads: WorkflowTerminalPayloadFactory;
}

export interface WorkflowRunStorageCompositionInput {
  readonly cwd: string;
  readonly projectCwd: string;
}

export interface WorkflowRunBootstrap {
  readonly backend: RunStorageBackend;
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

export interface WorkflowRunStorageComposition {
  readonly recovery: RunRecoveryPort;
  readonly admin: RunAdminPort;
  readonly storage: WorkflowRunStoragePort;
}

export interface RunRecoveryPort {
  reconcilePending(): Promise<void>;
}

export interface RunAdminPort {
  createForceFail(
    context: WorkflowRunForceFailContext,
  ): WorkflowRunForceFailHandle;
}

export interface WorkflowRunStoragePort {
  beginRun(input: {
    readonly workflowConfig: WorkflowConfig;
    readonly task: string;
    readonly requestedRunSlug?: string;
    readonly resumeSource?: RunResumeSource;
  }): Promise<WorkflowRunHandle>;
}

export function createWorkflowRunComposition(
  backend: RunStorageBackend,
  input: WorkflowRunStorageCompositionInput,
): WorkflowRunStorageComposition {
  const strategy = createWorkflowRunStorageAdapter(backend, input);
  return Object.freeze({
    recovery: Object.freeze({
      reconcilePending: () => reconcilePendingWorkflowRuns({
        cwd: input.cwd,
      }),
    }),
    admin: Object.freeze({
      createForceFail: strategy.createForceFail.bind(strategy),
    }),
    storage: Object.freeze({
      beginRun: (
        runInput: Parameters<WorkflowRunStoragePort['beginRun']>[0],
      ) => {
        const startedAt = new Date().toISOString();
        const bootstrapSeed = createBootstrapRecoverySeed({
          task: runInput.task,
          workflowName: runInput.workflowConfig.name,
          projectCwd: input.projectCwd,
          backend,
          startedAt,
          sessionId: generateSessionId(),
          ...(runInput.resumeSource === undefined
            ? {}
            : { resumeSource: runInput.resumeSource }),
        });
        return strategy.beginRun({ ...runInput, bootstrapSeed });
      },
    }),
  });
}

export function createWorkflowRunCompositionForExistingRun(
  meta: RunMeta,
  input: WorkflowRunStorageCompositionInput,
): WorkflowRunStorageComposition {
  const backend = resolveExistingRunStorageBackend(
    buildRunPaths(input.cwd, meta.runSlug),
  );
  if (meta.storageBackend !== backend) {
    throw new Error(
      `Run metadata backend "${meta.storageBackend}" conflicts with `
      + `${backend} authority for "${meta.runSlug}"`,
    );
  }
  return createWorkflowRunComposition(backend, input);
}

function createWorkflowRunStorageAdapter(
  backend: RunStorageBackend,
  input: WorkflowRunStorageCompositionInput,
): BaseWorkflowRunStorageAdapter {
  switch (backend) {
    case 'file':
      return new FileWorkflowRunStorageAdapter(input);
    case 'sqlite':
      return new SqliteWorkflowRunStorageAdapter(input);
    default:
      return assertNever(backend);
  }
}

export async function reconcilePendingWorkflowRuns(input: {
  readonly cwd: string;
}): Promise<void> {
  const runsDirectory = join(input.cwd, '.takt', 'runs');
  if (!existsSync(runsDirectory)) {
    return;
  }
  const runSlugs = readdirSync(runsDirectory, { withFileTypes: true })
    .filter((entry) => (
      entry.isDirectory()
      && isValidReportDirName(entry.name)
    ))
    .map((entry) => entry.name)
    .sort();
  for (const runSlug of runSlugs) {
    const runPaths = buildRunPaths(input.cwd, runSlug);
    const backend = detectExistingRunStorageBackend(runPaths);
    if (backend === undefined) {
      continue;
    }
    const adapter = createWorkflowRunStorageAdapter(backend, {
      cwd: input.cwd,
      projectCwd: input.cwd,
    });
    await adapter.recoverTerminal(runPaths);
  }
}

abstract class BaseWorkflowRunStorageAdapter {
  readonly #storageBackend: RunStorageBackend;

  constructor(input: {
    readonly storageBackend: RunStorageBackend;
  }) {
    this.#storageBackend = input.storageBackend;
  }

  abstract resolveRunSlug(input: {
    readonly cwd: string;
    readonly task: string;
    readonly requestedRunSlug?: string;
    readonly resumeSource?: RunResumeSource;
  }): string;

  abstract beginRun(input: {
    readonly workflowConfig: WorkflowConfig;
    readonly task: string;
    readonly requestedRunSlug?: string;
    readonly resumeSource?: RunResumeSource;
    readonly bootstrapSeed: BootstrapRecoverySeed;
  }): Promise<WorkflowRunHandle>;

  abstract createForceFail(
    context: WorkflowRunForceFailContext,
  ): WorkflowRunForceFailHandle;

  abstract recoverTerminal(
    runPaths: RunPaths,
  ): Promise<void>;

  assertResumeSource(input: {
    readonly cwd: string;
    readonly resumeSource?: RunResumeSource;
  }): void {
    assertResumeSourceBackend({
      expectedBackend: this.#storageBackend,
      ...input,
    });
  }

  publishRunMeta(input: {
    readonly runPaths: RunPaths;
    readonly task: string;
    readonly workflowName: string;
    readonly resumeSource?: RunResumeSource;
    readonly options?: RunMetaManagerOptions;
  }): RunMetaManager {
    const manager = new RunMetaManager(
      input.runPaths,
      input.task,
      input.workflowName,
      this.#storageBackend,
      input.resumeSource,
      input.options,
    );
    return manager;
  }

  protected requireValidRunSlug(runSlug: string): string {
    if (!isValidReportDirName(runSlug)) {
      throw new Error(`Invalid reportDirName: ${runSlug}`);
    }
    return runSlug;
  }
}

class FileWorkflowRunStorageAdapter
  extends BaseWorkflowRunStorageAdapter {
  readonly #cwd: string;
  readonly #projectCwd: string;

  constructor(input: WorkflowRunStorageCompositionInput) {
    super({ storageBackend: 'file' });
    this.#cwd = input.cwd;
    this.#projectCwd = input.projectCwd;
  }

  resolveRunSlug(input: {
    readonly task: string;
    readonly requestedRunSlug?: string;
  }): string {
    return this.requireValidRunSlug(
      input.requestedRunSlug ?? generateReportDir(input.task),
    );
  }

  createForceFail(
    context: WorkflowRunForceFailContext,
  ): WorkflowRunForceFailHandle {
    return createFileTaskRunForceFailStorage({
      ...context,
      cwd: this.#cwd,
      projectDir: this.#projectCwd,
    });
  }

  async recoverTerminal(
    _runPaths: RunPaths,
  ): Promise<void> {
    return Promise.resolve();
  }

  async beginRun(input: {
    readonly workflowConfig: WorkflowConfig;
    readonly task: string;
    readonly requestedRunSlug?: string;
    readonly resumeSource?: RunResumeSource;
    readonly bootstrapSeed: BootstrapRecoverySeed;
  }): Promise<WorkflowRunHandle> {
    this.assertResumeSource({
      cwd: this.#cwd,
      ...(input.resumeSource === undefined
        ? {}
        : { resumeSource: input.resumeSource }),
    });
    const runSlug = this.resolveRunSlug({
      task: input.task,
      ...(input.requestedRunSlug === undefined
        ? {}
        : { requestedRunSlug: input.requestedRunSlug }),
    });
    const runPaths = buildRunPaths(this.#cwd, runSlug);
    const abortController = new AbortController();
    let runMetaManager: RunMetaManager | undefined;
    let bound = false;
    const terminalPublisher = createFileWorkflowRunTerminalPublisher({
      runPaths,
    });
    const finish: WorkflowRunExecutionHandle['finish'] = async (
      outcome,
      payload,
    ) => terminalPublisher.finish(outcome, payload);
    const handle: WorkflowRunHandle = {
      runSlug: runPaths.slug,
      runPaths,
      bootstrap: Object.freeze({
        backend: 'file',
        runSlug: runPaths.slug,
        runPaths,
        startedAt: input.bootstrapSeed.startedAt,
        sessionId: input.bootstrapSeed.sessionId,
        publishRunMeta: (
          metaInput: Parameters<
            WorkflowRunBootstrap['publishRunMeta']
          >[0],
        ) => {
          assertRunPathsIdentity(metaInput.runPaths, runPaths);
          if (runMetaManager !== undefined) {
            return runMetaManager;
          }
          const manager = super.publishRunMeta({
            ...metaInput,
            options: {
              ...metaInput.options,
              startTime: input.bootstrapSeed.startedAt,
            },
          });
          runMetaManager = manager;
          return manager;
        },
      }),
      bindExecution: async (context) => {
        if (bound) {
          throw new Error(
            `File workflow run "${runPaths.slug}" is already bound`,
          );
        }
        bound = true;
        const executionControl = createWorkflowRunExecutionControl(
          abortController,
        );
        const findingAuthorityResolver = createFileFindingAuthorityResolver(
          { ...context, runPaths },
          this.#projectCwd,
        );
        return {
          findingAuthorityResolver,
          execution: {
            run: (operation) => operation(executionControl),
          },
        };
      },
      finish,
    };
    return Object.freeze(handle);
  }
}

class SqliteWorkflowRunStorageAdapter
  extends BaseWorkflowRunStorageAdapter {
  readonly #cwd: string;
  readonly #projectCwd: string;

  constructor(input: WorkflowRunStorageCompositionInput) {
    super({ storageBackend: 'sqlite' });
    this.#cwd = input.cwd;
    this.#projectCwd = input.projectCwd;
  }

  resolveRunSlug(input: {
    readonly cwd: string;
    readonly task: string;
    readonly requestedRunSlug?: string;
    readonly resumeSource?: RunResumeSource;
  }): string {
    const runSlug = this.requireValidRunSlug(
      input.requestedRunSlug
        ?? (input.resumeSource?.sourceRunSlug === undefined
          ? generateReportDir(input.task)
          : generateExecutionReportDir(input.cwd, input.task)),
    );
    if (input.resumeSource?.sourceRunSlug === runSlug) {
      throw new Error(
        `SQLite resume requires distinct source and target run slugs: "${runSlug}"`,
      );
    }
    return runSlug;
  }

  createForceFail(
    context: WorkflowRunForceFailContext,
  ): WorkflowRunForceFailHandle {
    return createSqliteTaskRunForceFailStorage({
      ...context,
      cwd: this.#cwd,
      projectDir: this.#projectCwd,
    });
  }

  async recoverTerminal(
    runPaths: RunPaths,
  ): Promise<void> {
    if (!existsSync(runPaths.databaseAbs)) {
      return;
    }
    const root = openRunStorageTerminalRecovery({
      databasePath: runPaths.databaseAbs,
    });
    let shouldReconcile = true;
    try {
      const snapshot = root.readResumeSnapshot();
      if (snapshot.run.status === 'running') {
        const seed = root.readBootstrapSeed();
        const reason = 'run_recovered_after_lease_expiry';
        const payload = createRecoveryTerminalPayload(
          seed,
          runPaths,
          reason,
        );
        try {
          root.forceFailRun({
            expectedRunId: runPaths.slug,
            ownerKey: `workflow-recovery:${runPaths.slug}`,
            leaseDurationMs: LEASE_DURATION_MS,
            reason,
            iteration: 0,
            publicationPayload:
              serializeWorkflowTerminalPublication(payload),
          });
        } catch (error) {
          if (
            error instanceof Error
            && error.message.includes('already has an active lease')
          ) {
            shouldReconcile = false;
          } else {
            throw error;
          }
        }
      }
    } finally {
      root.close();
    }
    if (!shouldReconcile) {
      return;
    }
    const finalization = await recoverWorkflowTerminalPublication({
      databasePath: runPaths.databaseAbs,
      expectedRunId: runPaths.slug,
    });
    throwFinalizationIssues(finalization.issues);
  }

  assertResumeSource(input: {
    readonly cwd: string;
    readonly resumeSource?: RunResumeSource;
  }): void {
    super.assertResumeSource(input);
    if (input.resumeSource?.sourceRunSlug !== undefined) {
      assertSqliteResumeSourceIdentity(
        input.cwd,
        input.resumeSource.sourceRunSlug,
      );
    }
  }

  async beginRun(input: {
    readonly workflowConfig: WorkflowConfig;
    readonly task: string;
    readonly requestedRunSlug?: string;
    readonly resumeSource?: RunResumeSource;
    readonly bootstrapSeed: BootstrapRecoverySeed;
  }): Promise<WorkflowRunHandle> {
    this.assertResumeSource({
      cwd: this.#cwd,
      ...(input.resumeSource === undefined
        ? {}
        : { resumeSource: input.resumeSource }),
    });
    const { root, runPaths } = this.reserveRun(input);
    const lease = root.claimLease({
      ownerKey: `workflow-execution:${runPaths.slug}`,
      leaseDurationMs: LEASE_DURATION_MS,
    });
    const abortController = new AbortController();
    const lifecycle = new SqliteWorkflowRunStorageLifecycle({
      root,
      lease,
      abortController,
    });
    let runMetaManager: RunMetaManager | undefined;
    let bound = false;
    const finish: WorkflowRunExecutionHandle['finish'] = async (
      outcome,
      payload,
    ) => {
      let snapshot: WorkflowTerminalPublicationPayload;
      try {
        assertTerminalPayloadRunIdentity(payload, runPaths.slug);
        assertTerminalStatus(payload, outcome.status);
        snapshot = deserializeWorkflowTerminalPublication(
          serializeWorkflowTerminalPublication(payload),
        );
      } catch (error) {
        const cleanup = lifecycle.closeUnfinished();
        if (cleanup.issues.length === 0) {
          throw error;
        }
        throw combineErrors(error, cleanup.issues);
      }
      const committed = lifecycle.finish(
        outcome,
        serializeWorkflowTerminalPublication(snapshot),
      );
      const projected = await reconcileWorkflowTerminalPublication({
        databasePath: runPaths.databaseAbs,
        expectedRunId: runPaths.slug,
      });
      return Object.freeze({
        receipt: committed.receipt,
        issues: Object.freeze([
          ...committed.issues,
          ...projected.issues,
        ]),
      });
    };
    const handle: WorkflowRunHandle = {
      runSlug: runPaths.slug,
      runPaths,
      bootstrap: Object.freeze({
        backend: 'sqlite',
        runSlug: runPaths.slug,
        runPaths,
        startedAt: input.bootstrapSeed.startedAt,
        sessionId: input.bootstrapSeed.sessionId,
        publishRunMeta: (
          metaInput: Parameters<
            WorkflowRunBootstrap['publishRunMeta']
          >[0],
        ) => {
          assertRunPathsIdentity(metaInput.runPaths, runPaths);
          if (runMetaManager !== undefined) {
            return runMetaManager;
          }
          const manager = super.publishRunMeta({
            ...metaInput,
            options: {
              ...metaInput.options,
              startTime: input.bootstrapSeed.startedAt,
            },
          });
          runMetaManager = manager;
          return manager;
        },
      }),
      bindExecution: async (_context) => {
        if (bound) {
          throw new Error(
            `SQLite workflow run "${runPaths.slug}" is already bound`,
          );
        }
        bound = true;
        const executionControl = createWorkflowRunExecutionControl(
          abortController,
        );
        const runtime = root.runtime({ lease });
        const topLevelExecution = runtime.execution.startStep({
          stepKey: TOP_LEVEL_WORKFLOW_EXECUTION_STEP_KEY,
          expectedScopeRevision: 0,
        }).handle;
        const stores = new Map<string, FindingLedgerStore>();
        const findingAuthorityResolver: FindingAuthorityResolver = {
          resolve({
            workflowConfig,
            workflowCallSiteIdentity,
          }): FindingLedgerStore {
            if (workflowConfig.findingContract === undefined) {
              throw new Error(
                `Finding authority requested for workflow `
                + `"${workflowConfig.name}" without Finding Contract`,
              );
            }
            const authorityKey = workflowCallSiteIdentity
              ?? JSON.stringify({ rootWorkflow: workflowConfig.name });
            const existing = stores.get(authorityKey);
            if (existing !== undefined) {
              return existing;
            }
            if (workflowCallSiteIdentity === undefined) {
              const store = runtime.findingManager({
                workflowName: workflowConfig.name,
                producer: topLevelExecution,
              });
              stores.set(authorityKey, store);
              return store;
            }
            const scope = runtime.scopes.resolveWorkflowCallChild({
              scopeKey: authorityKey,
              findingContractEnabled: true,
            });
            const childRuntime = root.runtime({ lease, scope });
            const childExecution = childRuntime.execution.startStep({
              stepKey: TOP_LEVEL_WORKFLOW_EXECUTION_STEP_KEY,
              expectedScopeRevision: 0,
            }).handle;
            const store = childRuntime.findingManager({
              workflowName: workflowConfig.name,
              producer: childExecution,
            });
            stores.set(authorityKey, store);
            return store;
          },
        };
        return {
          findingAuthorityResolver,
          execution: {
        run: async (operation) => {
          try {
            const result = await operation(executionControl);
            lifecycle.assertHealthy();
            return result;
          } catch (operationError) {
            try {
              lifecycle.assertHealthy();
            } catch (controlError) {
              throw new WorkflowRunExecutionControlError(
                controlError,
                operationError,
              );
            }
            throw operationError;
          }
        },
          },
        };
      },
      finish,
    };
    return Object.freeze(handle);
  }

  private reserveRun(input: {
    readonly workflowConfig: WorkflowConfig;
    readonly task: string;
    readonly requestedRunSlug?: string;
    readonly resumeSource?: RunResumeSource;
    readonly bootstrapSeed: BootstrapRecoverySeed;
  }): {
    readonly root: RunStorageRoot;
    readonly runPaths: RunPaths;
  } {
    let runSlug = this.resolveRunSlug({
      cwd: this.#cwd,
      task: input.task,
      ...(input.requestedRunSlug === undefined
        ? {}
        : { requestedRunSlug: input.requestedRunSlug }),
      ...(input.resumeSource === undefined
        ? {}
        : { resumeSource: input.resumeSource }),
    });
    while (true) {
      const runPaths = buildRunPaths(this.#cwd, runSlug);
      if (!existsSync(runPaths.runRootAbs)) {
        try {
          const root = createSqliteRunStorageRoot({
            workflowConfig: input.workflowConfig,
            runPaths,
            cwd: this.#cwd,
            bootstrapSeed: input.bootstrapSeed,
            ...(input.resumeSource === undefined
              ? {}
              : { resumeSource: input.resumeSource }),
          });
          return { root, runPaths };
        } catch (error) {
          if (
            input.requestedRunSlug !== undefined
            || !existsSync(runPaths.runRootAbs)
          ) {
            throw error;
          }
        }
      } else if (input.requestedRunSlug !== undefined) {
        throw new Error(`Run directory already exists: ${runPaths.runRootAbs}`);
      }
      runSlug = generateExecutionReportDir(this.#cwd, input.task);
    }
  }
}

function createRecoveryTerminalPayload(
  seed: BootstrapRecoverySeed,
  runPaths: RunPaths,
  reason: string,
): WorkflowTerminalPublicationPayload {
  const sessionLog = createSessionLog(
    seed.task,
    seed.projectCwd,
    seed.workflowName,
    { startTime: seed.startedAt },
  );
  return createWorkflowTerminalPayloadFactory({
    runSlug: runPaths.slug,
    projectCwd: seed.projectCwd,
    task: seed.task,
    workflowName: seed.workflowName,
    sessionLog,
    sessionId: seed.sessionId,
    ndjsonLogPath: join(
      runPaths.logsAbs,
      `${seed.sessionId}.jsonl`,
    ),
    traceReportMode: 'redacted',
    metaSeed: {
      backend: seed.backend,
      startedAt: seed.startedAt,
      resumeSource: seed.resumeSource,
    },
  }).create({
    status: 'failed',
    iterations: 0,
    reason,
    lastStepContent: undefined,
    lastStepName: undefined,
    endTime: new Date().toISOString(),
  });
}

function assertTerminalStatus(
  payload: WorkflowTerminalPublicationPayload,
  status: WorkflowRunTerminalStatus,
): void {
  const expectedPublicationStatus =
    status === 'cancelled' ? 'aborted' : status;
  if (payload.status !== expectedPublicationStatus) {
    throw new Error(
      `Workflow terminal payload status "${payload.status}" `
      + `does not match run status "${status}"`,
    );
  }
}

function assertTerminalPayloadRunIdentity(
  payload: WorkflowTerminalPublicationPayload,
  expectedRunSlug: string,
): void {
  if (payload.runSlug !== expectedRunSlug) {
    throw new Error(
      `Workflow terminal payload identity does not match run `
      + `"${expectedRunSlug}"`,
    );
  }
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

function assertResumeSourceBackend(input: {
  readonly expectedBackend: RunStorageBackend;
  readonly cwd: string;
  readonly resumeSource?: RunResumeSource;
}): void {
  const sourceRunSlug = input.resumeSource?.sourceRunSlug;
  if (sourceRunSlug === undefined) {
    return;
  }
  const sourceBackend = resolveExistingRunStorageBackend(
    buildRunPaths(input.cwd, sourceRunSlug),
  );
  if (sourceBackend !== input.expectedBackend) {
    throw new Error(
      `Run storage backend mismatch for resume source "${sourceRunSlug}": `
      + `expected "${input.expectedBackend}", got "${sourceBackend}"`,
    );
  }
}

function detectExistingRunStorageBackend(
  runPaths: RunPaths,
): RunStorageBackend | undefined {
  if (existsSync(runPaths.databaseAbs)) {
    return 'sqlite';
  }
  const meta = readRunMeta(runPaths.metaAbs);
  if (meta === null) {
    return undefined;
  }
  if (meta.storageBackend !== 'file') {
    throw new Error(
      `SQLite run storage is missing for "${runPaths.slug}"`,
    );
  }
  return 'file';
}

function resolveExistingRunStorageBackend(
  runPaths: RunPaths,
): RunStorageBackend {
  const backend = detectExistingRunStorageBackend(runPaths);
  if (backend === undefined) {
    throw new Error(
      `Run authority is missing for "${runPaths.slug}"`,
    );
  }
  return backend;
}

function assertSqliteResumeSourceIdentity(
  cwd: string,
  sourceRunSlug: string,
): void {
  const sourcePaths = buildRunPaths(cwd, sourceRunSlug);
  const source = openRunStorageResumeSource({
    databasePath: sourcePaths.databaseAbs,
  });
  let primaryError: unknown;
  try {
    const snapshot = source.readResumeSnapshot();
    if (snapshot.run.runId !== sourceRunSlug) {
      throw new Error(
        `SQLite resume source database slug "${String(snapshot.run.runId)}" `
        + `does not match requested source run "${sourceRunSlug}"`,
      );
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    source.close();
  } catch (error) {
    if (primaryError === undefined) {
      throw error;
    }
    throw new AggregateError(
      [primaryError, error],
      errorMessage(primaryError),
      { cause: primaryError },
    );
  }
  if (primaryError !== undefined) {
    throw primaryError;
  }
}

function createFileFindingAuthorityResolver(
  input: WorkflowRunExecutionContext,
  projectCwd: string,
): FindingAuthorityResolver {
  return {
    resolve({ workflowConfig, runPaths }): FindingLedgerStore {
      const contract = workflowConfig.findingContract;
      if (contract === undefined) {
        throw new Error(
          `Finding authority requested for workflow "${workflowConfig.name}" without Finding Contract`,
        );
      }
      return createFindingLedgerStore({
        projectCwd,
        runId: input.runPaths.slug,
        reportDir: runPaths.reportsAbs,
        workflowName: workflowConfig.name,
        ledgerPath: contract.ledgerPath,
        rawFindingsPath: contract.rawFindingsPath,
        ...(input.resumeSource?.sourceRunSlug === undefined
          ? {}
          : { trustedResumeSourceRunId: input.resumeSource.sourceRunSlug }),
      });
    },
  };
}

function createSqliteRunStorageRoot(
  input: {
    readonly workflowConfig: WorkflowConfig;
    readonly runPaths: RunPaths;
    readonly resumeSource?: RunResumeSource;
    readonly cwd: string;
    readonly bootstrapSeed: BootstrapRecoverySeed;
  },
): RunStorageRoot {
  const createOptions = (findingContractEnabled: boolean) => ({
    databasePath: input.runPaths.databaseAbs,
    run: {
      runId: input.runPaths.slug,
      workflowName: input.workflowConfig.name,
      findingContractEnabled,
    },
    bootstrapSeed: input.bootstrapSeed,
  } as const);
  const rootFindingContractEnabled =
    input.workflowConfig.findingContract !== undefined;
  const sourceRunSlug = input.resumeSource?.sourceRunSlug;
  if (sourceRunSlug === undefined) {
    return createRunStorage(createOptions(rootFindingContractEnabled));
  }

  const sourcePaths = buildRunPaths(input.cwd, sourceRunSlug);
  if (sourcePaths.databaseAbs === input.runPaths.databaseAbs) {
    throw new Error(
      `SQLite resume source and target database paths are identical: ${sourcePaths.databaseAbs}`,
    );
  }
  const source = openRunStorageResumeSource({
    databasePath: sourcePaths.databaseAbs,
  });
  let target: RunStorageRoot | undefined;
  let primaryError: unknown;
  try {
    const sourceSnapshot = source.readResumeSnapshot();
    if (sourceSnapshot.run.runId !== sourceRunSlug) {
      throw new Error(
        `SQLite resume source database slug "${String(sourceSnapshot.run.runId)}" `
        + `does not match requested source run "${sourceRunSlug}"`,
      );
    }
    target = resumeRunStorage({
      ...createOptions(rootFindingContractEnabled),
      source,
    });
  } catch (error) {
    primaryError = error;
  }

  const closeErrors: unknown[] = [];
  try {
    source.close();
  } catch (error) {
    closeErrors.push(error);
  }
  if (primaryError !== undefined || closeErrors.length !== 0) {
    if (target !== undefined) {
      try {
        target.close();
      } catch (error) {
        closeErrors.push(error);
      }
    }
    const primary = primaryError ?? closeErrors[0];
    const errors = primaryError === undefined
      ? closeErrors
      : [primaryError, ...closeErrors];
    if (errors.length === 1) {
      throw primary;
    }
    throw new AggregateError(errors, errorMessage(primary), { cause: primary });
  }
  if (target === undefined) {
    throw new Error('SQLite resume did not create a target run storage');
  }
  return target;
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

function throwFinalizationIssues(issues: readonly unknown[]): void {
  if (issues.length === 0) {
    return;
  }
  if (issues.length === 1) {
    throw issues[0];
  }
  throw combineErrors(issues[0], issues.slice(1));
}

function assertNever(value: never): never {
  throw new Error(`Unknown workflow abort kind: ${String(value)}`);
}
