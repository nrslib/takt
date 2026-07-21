/**
 * RunMeta — 実行メタデータの管理モジュール
 *
 * ランのメタデータ（task, workflow, status, 開始・終了時刻など）を
 * .takt/runs/{slug}/meta.json へ書き出す責務を担う。
 */

import { writeFileAtomic, ensureDir } from '../../../infra/config/index.js';
import type { RunMeta, RunResumeSource } from '../../../core/workflow/run/run-meta.js';
import type { RunPaths } from '../../../core/workflow/run/run-paths.js';
import type { WorkflowResumePoint } from '../../../core/models/index.js';
import type { WorkflowTraceDiscovery } from '../../../core/workflow/observability/traceDiscovery.js';

export interface RunMetaManagerOptions {
  readonly traceDiscovery?: WorkflowTraceDiscovery;
  /** resume-artifacts.json（継承 manifest）への相対パス。SSOT は manifest 側。 */
  readonly resumeArtifactsRel?: string;
}

type PersistedRunMeta = Omit<RunMeta, 'resumePoint' | 'sourceRunSlug' | 'resumeMode' | 'resumeArtifacts'> & {
  resume_point?: WorkflowResumePoint;
  source_run_slug?: string;
  resume_mode?: RunResumeSource['resumeMode'];
  resume_artifacts?: string;
};

export class RunMetaManager {
  private readonly runMeta: RunMeta;
  private readonly metaAbs: string;
  private finalized = false;

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
      startTime: new Date().toISOString(),
      ...(resumeSource ? {
        resumeMode: resumeSource.resumeMode,
        ...(resumeSource.sourceRunSlug ? { sourceRunSlug: resumeSource.sourceRunSlug } : {}),
      } : {}),
      ...(options?.resumeArtifactsRel ? { resumeArtifacts: options.resumeArtifactsRel } : {}),
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

  finalize(status: 'completed' | 'aborted', iterations?: number): void {
    this.writeRunMeta({
      ...this.runMeta,
      status,
      endTime: new Date().toISOString(),
      ...(iterations != null ? { iterations } : {}),
    } satisfies RunMeta);
    this.finalized = true;
  }

  get isFinalized(): boolean {
    return this.finalized;
  }

  private writeRunMeta(meta: RunMeta): void {
    const updatedAt = new Date().toISOString();
    const { resumePoint, sourceRunSlug, resumeMode, resumeArtifacts, ...baseMeta } = meta;
    const serialized: PersistedRunMeta = {
      ...baseMeta,
      updatedAt,
      ...(resumePoint ? { resume_point: resumePoint } : {}),
      ...(sourceRunSlug ? { source_run_slug: sourceRunSlug } : {}),
      ...(resumeMode ? { resume_mode: resumeMode } : {}),
      ...(resumeArtifacts ? { resume_artifacts: resumeArtifacts } : {}),
    };
    this.runMeta.updatedAt = updatedAt;
    writeFileAtomic(this.metaAbs, JSON.stringify(serialized, null, 2));
  }
}
