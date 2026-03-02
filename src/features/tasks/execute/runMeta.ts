/**
 * RunMeta — 実行メタデータの管理モジュール
 *
 * ランのメタデータ（task, piece, status, 開始・終了時刻など）を
 * .takt/runs/{slug}/meta.json へ書き出す責務を担う。
 */

import { writeFileAtomic, ensureDir } from '../../../infra/config/index.js';
import type { RunPaths } from '../../../core/piece/run/run-paths.js';

interface RunMeta {
  task: string;
  piece: string;
  runSlug: string;
  runRoot: string;
  reportDirectory: string;
  contextDirectory: string;
  logsDirectory: string;
  status: 'running' | 'completed' | 'aborted';
  startTime: string;
  endTime?: string;
  iterations?: number;
}

export class RunMetaManager {
  private readonly runMeta: RunMeta;
  private readonly metaAbs: string;
  private finalized = false;

  constructor(runPaths: RunPaths, task: string, pieceName: string) {
    this.metaAbs = runPaths.metaAbs;
    this.runMeta = {
      task,
      piece: pieceName,
      runSlug: runPaths.slug,
      runRoot: runPaths.runRootRel,
      reportDirectory: runPaths.reportsRel,
      contextDirectory: runPaths.contextRel,
      logsDirectory: runPaths.logsRel,
      status: 'running',
      startTime: new Date().toISOString(),
    };
    ensureDir(runPaths.runRootAbs);
    writeFileAtomic(this.metaAbs, JSON.stringify(this.runMeta, null, 2));
  }

  finalize(status: 'completed' | 'aborted', iterations?: number): void {
    writeFileAtomic(this.metaAbs, JSON.stringify({
      ...this.runMeta,
      status,
      endTime: new Date().toISOString(),
      ...(iterations != null ? { iterations } : {}),
    } satisfies RunMeta, null, 2));
    this.finalized = true;
  }

  get isFinalized(): boolean {
    return this.finalized;
  }
}
