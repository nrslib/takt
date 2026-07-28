/**
 * RunMeta — 実行メタデータの管理モジュール
 *
 * ランのメタデータ（task, workflow, status, 開始・終了時刻など）を
 * .takt/runs/{slug}/meta.json へ書き出す責務を担う。
 */

import { writeFileAtomic, ensureDir } from '../../../infra/config/index.js';
import {
  readRunMeta,
  parseRunMeta,
  type RunMeta,
  type RunResumeSource,
  parseWorkflowResumePoint,
} from '../../../core/workflow/run/run-meta.js';
import type { RunPaths } from '../../../core/workflow/run/run-paths.js';
import type { WorkflowResumePoint } from '../../../core/models/index.js';
import type { WorkflowTraceDiscovery } from '../../../core/workflow/observability/traceDiscovery.js';
import type { RunStorageBackend } from '../../../core/models/config-types.js';
import {
  createPullRequestContext,
  encodePullRequestContext,
  type PersistedPullRequestContext,
  type PullRequestContext,
} from '../../../core/workflow/pr-context.js';
import {
  PrivateArtifactPublicationConflictError,
  readPrivateFileState,
  writePrivateFileWithModeExpected,
} from '../../../shared/utils/private-file.js';

const RUN_META_MODE = 0o600;

export interface RunMetaManagerOptions {
  readonly startTime?: string;
  readonly traceDiscovery?: WorkflowTraceDiscovery;
  /** resume-artifacts.json（継承 manifest）への相対パス。SSOT は manifest 側。 */
  readonly resumeArtifactsRel?: string;
  readonly operationJournalRunSlug?: string;
  readonly operationClaimToken?: string;
  readonly prContext?: PullRequestContext;
}

type PersistedRunMeta = Omit<
  RunMeta,
  | 'resumePoint'
  | 'sourceRunSlug'
  | 'resumeMode'
  | 'resumeArtifacts'
  | 'operationJournalRunSlug'
  | 'operationClaimToken'
  | 'prContext'
  | 'terminalPublicationId'
> & {
  resume_point?: WorkflowResumePoint;
  source_run_slug?: string;
  resume_mode?: RunResumeSource['resumeMode'];
  resume_artifacts?: string;
  operation_journal_run_slug?: string;
  operation_claim_token?: string;
  pr_context?: PersistedPullRequestContext;
  terminal_publication_id?: string;
};

function serializeRunMeta(meta: RunMeta, updatedAt: string): PersistedRunMeta {
  const {
    resumePoint,
    sourceRunSlug,
    resumeMode,
    resumeArtifacts,
    operationJournalRunSlug,
    operationClaimToken,
    prContext,
    terminalPublicationId,
    ...baseMeta
  } = meta;
  return {
    ...baseMeta,
    updatedAt,
    ...(resumePoint ? { resume_point: parseWorkflowResumePoint(resumePoint) } : {}),
    ...(sourceRunSlug ? { source_run_slug: sourceRunSlug } : {}),
    ...(resumeMode ? { resume_mode: resumeMode } : {}),
    ...(resumeArtifacts ? { resume_artifacts: resumeArtifacts } : {}),
    ...(operationJournalRunSlug
      ? { operation_journal_run_slug: operationJournalRunSlug }
      : {}),
    ...(operationClaimToken
      ? { operation_claim_token: operationClaimToken }
      : {}),
    ...(prContext ? { pr_context: encodePullRequestContext(prContext) } : {}),
    ...(terminalPublicationId === undefined
      ? {}
      : { terminal_publication_id: terminalPublicationId }),
  };
}

export function projectTerminalRunMeta(input: {
  readonly runPaths: RunPaths;
  readonly publicationId: string;
  readonly seed: {
    readonly task: string;
    readonly workflowName: string;
    readonly projectCwd: string;
    readonly backend: RunStorageBackend;
    readonly startedAt: string;
    readonly resumeSource: null | {
      readonly mode: RunResumeSource['resumeMode'];
      readonly sourceRunSlug: string | null;
    };
  };
  readonly status: 'completed' | 'aborted' | 'failed';
  readonly iterations: number;
  readonly reason?: string;
  readonly endTime: string;
}): void {
  while (true) {
    const snapshot = readPrivateFileState(input.runPaths.metaAbs);
    const current = snapshot.state.exists
      ? parseRunMeta(JSON.parse(
          requireMetaContent(snapshot, input.runPaths.metaAbs)
            .toString('utf-8'),
        ) as unknown)
      : createRunMetaFromTerminalSeed(input);
    assertTerminalMetaIdentity(current, input);
    const finalized: RunMeta = {
      ...current,
      status: input.status,
      endTime: input.endTime,
      iterations: input.iterations,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      terminalPublicationId: input.publicationId,
    };
    if (
      current.terminalPublicationId === input.publicationId
      && current.status === finalized.status
      && current.endTime === finalized.endTime
      && current.iterations === finalized.iterations
      && current.reason === finalized.reason
    ) {
      return;
    }
    if (
      current.terminalPublicationId !== undefined
      || current.status !== 'running'
    ) {
      throw new Error(
        `Run metadata terminal state conflicts for "${input.runPaths.slug}"`,
      );
    }
    try {
      writePrivateFileWithModeExpected(
        input.runPaths.metaAbs,
        JSON.stringify(
          serializeRunMeta(finalized, input.endTime),
          null,
          2,
        ),
        RUN_META_MODE,
        snapshot.state,
      );
      return;
    } catch (error) {
      if (error instanceof PrivateArtifactPublicationConflictError) {
        continue;
      }
      throw error;
    }
  }
}

export function finalizeFileRunMeta(input: {
  readonly runPaths: RunPaths;
  readonly status: 'completed' | 'aborted' | 'failed';
  readonly iterations: number;
  readonly reason?: string;
  readonly endTime: string;
}): void {
  const current = readRunMeta(input.runPaths.metaAbs);
  if (
    current === null
    || current.runSlug !== input.runPaths.slug
    || current.storageBackend !== 'file'
  ) {
    throw new Error(
      `File run metadata identity does not match "${input.runPaths.slug}"`,
    );
  }
  const finalized: RunMeta = {
    ...current,
    terminalPublicationId: undefined,
    status: input.status,
    endTime: input.endTime,
    iterations: input.iterations,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
  writeFileAtomic(
    input.runPaths.metaAbs,
    JSON.stringify(serializeRunMeta(finalized, input.endTime), null, 2),
  );
}

function assertTerminalMetaIdentity(
  current: RunMeta,
  input: {
    readonly runPaths: RunPaths;
    readonly seed: {
      readonly task: string;
      readonly workflowName: string;
      readonly backend: RunStorageBackend;
      readonly startedAt: string;
    };
  },
): void {
  if (
    current.runSlug !== input.runPaths.slug
    || current.task !== input.seed.task
    || current.workflow !== input.seed.workflowName
    || current.storageBackend !== input.seed.backend
    || current.startTime !== input.seed.startedAt
  ) {
    throw new Error(
      `Run metadata identity conflicts for "${input.runPaths.slug}"`,
    );
  }
}

function requireMetaContent(
  snapshot: ReturnType<typeof readPrivateFileState>,
  path: string,
): Buffer {
  if (!('content' in snapshot)) {
    throw new Error(`Run metadata content is missing: ${path}`);
  }
  return snapshot.content;
}

function createRunMetaFromTerminalSeed(input: {
  readonly runPaths: RunPaths;
  readonly seed: {
    readonly task: string;
    readonly workflowName: string;
    readonly projectCwd: string;
    readonly backend: RunStorageBackend;
    readonly startedAt: string;
    readonly resumeSource: null | {
      readonly mode: RunResumeSource['resumeMode'];
      readonly sourceRunSlug: string | null;
    };
  };
}): RunMeta {
  return {
    task: input.seed.task,
    workflow: input.seed.workflowName,
    runSlug: input.runPaths.slug,
    runRoot: input.runPaths.runRootRel,
    reportDirectory: input.runPaths.reportsRel,
    contextDirectory: input.runPaths.contextRel,
    logsDirectory: input.runPaths.logsRel,
    storageBackend: input.seed.backend,
    status: 'running',
    startTime: input.seed.startedAt,
    ...(input.seed.resumeSource === null
      ? {}
      : {
          resumeMode: input.seed.resumeSource.mode,
          ...(input.seed.resumeSource.sourceRunSlug === null
            ? {}
            : {
                sourceRunSlug: input.seed.resumeSource.sourceRunSlug,
              }),
        }),
  };
}

export class RunMetaManager {
  private readonly runMeta: RunMeta;
  private readonly metaAbs: string;

  constructor(
    runPaths: RunPaths,
    task: string,
    workflowName: string,
    storageBackend: RunStorageBackend,
    resumeSource?: RunResumeSource,
    options?: RunMetaManagerOptions,
  ) {
    this.metaAbs = runPaths.metaAbs;
    this.runMeta = {
      task,
      workflow: workflowName,
      runSlug: runPaths.slug,
      runRoot: runPaths.runRootRel,
      reportDirectory: runPaths.reportsRel,
      contextDirectory: runPaths.contextRel,
      logsDirectory: runPaths.logsRel,
      storageBackend,
      status: 'running',
      startTime: options?.startTime ?? new Date().toISOString(),
      ...(resumeSource ? {
        resumeMode: resumeSource.resumeMode,
        ...(resumeSource.sourceRunSlug ? { sourceRunSlug: resumeSource.sourceRunSlug } : {}),
      } : {}),
      ...(options?.resumeArtifactsRel ? { resumeArtifacts: options.resumeArtifactsRel } : {}),
      ...(options?.operationJournalRunSlug === undefined
        ? {}
        : { operationJournalRunSlug: options.operationJournalRunSlug }),
      ...(options?.operationClaimToken === undefined
        ? {}
        : { operationClaimToken: options.operationClaimToken }),
      ...(options?.prContext ? { prContext: createPullRequestContext(options.prContext) } : {}),
      ...(options?.traceDiscovery ? {
        observability: {
          traceDiscovery: options.traceDiscovery,
        },
      } : {}),
    };
    ensureDir(runPaths.runRootAbs);
    this.writeRunMeta(this.runMeta);
  }

  updateStep(stepName: string, iteration: number, resumePoint?: WorkflowResumePoint): void {
    this.runMeta.currentStep = stepName;
    this.runMeta.currentIteration = iteration;
    delete this.runMeta.phase;
    this.runMeta.resumePoint = resumePoint;
    this.writeRunMeta(this.runMeta);
  }

  updatePhase(stepName: string, iteration: number, phase: 1 | 2 | 3): void {
    this.runMeta.currentStep = stepName;
    this.runMeta.currentIteration = iteration;
    this.runMeta.phase = phase;
    this.writeRunMeta(this.runMeta);
  }

  updateResumePoint(resumePoint?: WorkflowResumePoint): void {
    this.runMeta.resumePoint = resumePoint;
    this.writeRunMeta(this.runMeta);
  }

  projectTerminal(input: {
    readonly status: 'completed' | 'aborted' | 'failed';
    readonly iterations: number;
    readonly reason?: string;
    readonly endTime: string;
  }): void {
    if (this.runMeta.status !== 'running') {
      if (
        this.runMeta.status === input.status
        && this.runMeta.endTime === input.endTime
        && this.runMeta.iterations === input.iterations
        && this.runMeta.reason === input.reason
      ) {
        return;
      }
      throw new Error('Run metadata terminal projection conflicts with committed outcome');
    }
    this.runMeta.status = input.status;
    this.runMeta.endTime = input.endTime;
    this.runMeta.iterations = input.iterations;
    if (input.reason === undefined) {
      delete this.runMeta.reason;
    } else {
      this.runMeta.reason = input.reason;
    }
    this.writeRunMeta(this.runMeta);
  }

  private writeRunMeta(meta: RunMeta): void {
    const updatedAt = new Date().toISOString();
    this.runMeta.updatedAt = updatedAt;
    writeFileAtomic(
      this.metaAbs,
      JSON.stringify(serializeRunMeta(meta, updatedAt), null, 2),
    );
  }
}
