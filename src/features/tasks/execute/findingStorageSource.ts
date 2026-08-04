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
    const parentSourceRunSlug = resolveParentSourceRunSlug({
      cwd,
      sourceRunSlug,
    });
    if (parentSourceRunSlug === undefined) {
      return undefined;
    }
    sourceRunSlug = parentSourceRunSlug;
  }
}

function resolveParentSourceRunSlug(input: {
  readonly cwd: string;
  readonly sourceRunSlug: string;
}): string | undefined {
  const sourceMeta = readRunMetaBySlug(input.cwd, input.sourceRunSlug);
  if (sourceMeta === null) {
    throw new Error(
      `Finding storage source run "${input.sourceRunSlug}" has no readable metadata`,
    );
  }
  return sourceMeta.sourceRunSlug;
}
