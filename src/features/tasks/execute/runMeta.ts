/**
 * RunMeta — 実行メタデータの管理モジュール
 *
 * ランのメタデータ（task, workflow, status, 開始・終了時刻など）を
 * .takt/runs/{slug}/meta.json へ書き出す責務を担う。
 */

import { writeFileAtomic, ensureDir } from '../../../infra/config/index.js';
import {
  readRunMeta,
  type RunMeta,
  type RunFailure,
  type RunResumeSource,
} from '../../../core/workflow/run/run-meta.js';
import { parseWorkflowResumePoint } from '../../../core/workflow/resume-point-codec.js';
import type { RunPaths } from '../../../core/workflow/run/run-paths.js';
import type { WorkflowResumePoint } from '../../../core/models/index.js';
import type { WorkflowTraceDiscovery } from '../../../core/workflow/observability/traceDiscovery.js';
import {
  createPullRequestContext,
  encodePullRequestContext,
  type PersistedPullRequestContext,
  type PullRequestContext,
} from '../../../core/workflow/pr-context.js';

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
> & {
  resume_point?: WorkflowResumePoint;
  source_run_slug?: string;
  resume_mode?: RunResumeSource['resumeMode'];
  resume_artifacts?: string;
  operation_journal_run_slug?: string;
  operation_claim_token?: string;
  pr_context?: PersistedPullRequestContext;
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
  };
}

export function finalizeFileRunMeta(input: {
  readonly runPaths: RunPaths;
  readonly status: 'completed' | 'aborted' | 'failed';
  readonly iterations: number;
  readonly reason?: string;
  readonly failure?: RunFailure;
  readonly endTime: string;
}): void {
  const current = readRunMeta(input.runPaths.metaAbs);
  if (
    current === null
    || current.runSlug !== input.runPaths.slug
  ) {
    throw new Error(
      `File run metadata identity does not match "${input.runPaths.slug}"`,
    );
  }
  const finalized: RunMeta = {
    ...current,
    status: input.status,
    endTime: input.endTime,
    iterations: input.iterations,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.failure === undefined ? {} : { failure: input.failure }),
  };
  if (input.failure === undefined) {
    delete finalized.failure;
  }
  writeFileAtomic(
    input.runPaths.metaAbs,
    JSON.stringify(serializeRunMeta(finalized, input.endTime), null, 2),
  );
}

export class RunMetaManager {
  private readonly runMeta: RunMeta;
  private readonly metaAbs: string;

  constructor(
    runPaths: RunPaths,
    task: string,
    workflowName: string,
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
    readonly failure?: RunFailure;
    readonly endTime: string;
  }): void {
    if (this.runMeta.status !== 'running') {
      if (
        this.runMeta.status === input.status
        && this.runMeta.endTime === input.endTime
        && this.runMeta.iterations === input.iterations
        && this.runMeta.reason === input.reason
        && this.runMeta.failure?.step === input.failure?.step
        && this.runMeta.failure?.error === input.failure?.error
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
    if (input.failure === undefined) {
      delete this.runMeta.failure;
    } else {
      this.runMeta.failure = input.failure;
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
