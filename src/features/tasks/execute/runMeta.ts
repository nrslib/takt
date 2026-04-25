/**
 * RunMeta — 実行メタデータの管理モジュール
 *
 * ランのメタデータ（task, workflow, status, 開始・終了時刻など）を
 * .takt/runs/{slug}/meta.json へ書き出す責務を担う。
 */

import { writeFileAtomic, ensureDir } from '../../../infra/config/index.js';
import type { RunMeta } from '../../../core/workflow/run/run-meta.js';
import type { RunPaths } from '../../../core/workflow/run/run-paths.js';
import type { WorkflowResumePoint } from '../../../core/models/index.js';

type PersistedRunMeta = Omit<RunMeta, 'resumePoint'> & {
  resume_point?: WorkflowResumePoint;
};

export class RunMetaManager {
  private readonly runMeta: RunMeta;
  private readonly metaAbs: string;
  private finalized = false;

  constructor(runPaths: RunPaths, task: string, workflowName: string) {
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
    const serialized: PersistedRunMeta = {
      ...meta,
      updatedAt,
      ...(meta.resumePoint ? { resume_point: meta.resumePoint } : {}),
    };
    delete (serialized as Partial<RunMeta>).resumePoint;
    this.runMeta.updatedAt = updatedAt;
    writeFileAtomic(this.metaAbs, JSON.stringify(serialized, null, 2));
  }
}
