import { existsSync } from 'node:fs';
import type { RunResumeSource } from '../../../core/workflow/run/run-meta.js';
import { readRunMetaBySlug } from '../../../core/workflow/run/run-meta.js';
import { buildRunPaths } from '../../../core/workflow/run/run-paths.js';
import {
  hasAnyFindingAuthority,
  type FindingStorageSource,
} from '../../../infra/finding-storage/index.js';
import { isValidReportDirName } from '../../../shared/utils/index.js';

export function resolveFindingStorageSource(
  cwd: string,
  resumeSource: RunResumeSource | undefined,
): FindingStorageSource | undefined {
  if (resumeSource === undefined || resumeSource.sourceRunSlug === undefined) {
    return undefined;
  }
  const visited = new Set<string>();
  let sourceRunSlug = resumeSource.sourceRunSlug;
  while (true) {
    if (!isValidReportDirName(sourceRunSlug)) {
      throw new Error(`Finding storage source run slug "${sourceRunSlug}" is invalid`);
    }
    if (visited.has(sourceRunSlug)) {
      throw new Error(
        `Finding storage source ancestry contains a cycle at "${sourceRunSlug}"`,
      );
    }
    visited.add(sourceRunSlug);
    const sourceDatabasePath = buildRunPaths(
      cwd,
      sourceRunSlug,
    ).findingContractDatabaseAbs;
    const source = {
      databasePath: sourceDatabasePath,
      runId: sourceRunSlug,
    };
    const databaseExists = existsSync(sourceDatabasePath);
    if (databaseExists && hasAnyFindingAuthority(source)) {
      return source;
    }
    sourceRunSlug = requireParentSourceRunSlug({
      cwd,
      sourceRunSlug,
      sourceDatabasePath,
      databaseExists,
      resumeMode: resumeSource.resumeMode,
    });
  }
}

function requireParentSourceRunSlug(input: {
  readonly cwd: string;
  readonly sourceRunSlug: string;
  readonly sourceDatabasePath: string;
  readonly databaseExists: boolean;
  readonly resumeMode: RunResumeSource['resumeMode'];
}): string {
  const sourceMeta = readRunMetaBySlug(input.cwd, input.sourceRunSlug);
  if (sourceMeta?.sourceRunSlug !== undefined) {
    return sourceMeta.sourceRunSlug;
  }
  if (!input.databaseExists && input.resumeMode === 'requeue') {
    throw missingRequeueSourceDatabase(
      input.sourceRunSlug,
      input.sourceDatabasePath,
    );
  }
  if (sourceMeta === null) {
    throw new Error(
      `Finding storage source run "${input.sourceRunSlug}" has no readable metadata`,
    );
  }
  throw new Error(
    `Finding storage source ancestry ended at unseeded run "${input.sourceRunSlug}"`,
  );
}

function missingRequeueSourceDatabase(
  sourceRunSlug: string,
  sourceDatabasePath: string,
): Error {
  return new Error(
    `Requeue source run "${sourceRunSlug}" has no finding contract database: `
    + sourceDatabasePath,
  );
}
