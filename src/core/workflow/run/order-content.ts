import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isPathInside, isRealPathInside, isValidReportDirName } from '../../../shared/utils/index.js';
import { buildRunPaths } from './run-paths.js';

export interface ReadRunContextOrderContentOptions {
  readonly onError?: (orderPath: string, error: unknown) => void;
}

export function readRunContextOrderContent(
  cwd: string,
  slug: string,
  options?: ReadRunContextOrderContentOptions,
): string | undefined {
  if (!isValidReportDirName(slug)) {
    return undefined;
  }

  const runsDir = resolve(cwd, '.takt', 'runs');
  const runPaths = buildRunPaths(cwd, slug);
  if (!isPathInside(runsDir, runPaths.contextTaskOrderAbs)) {
    return undefined;
  }

  if (!existsSync(runPaths.contextTaskOrderAbs)) {
    return undefined;
  }
  if (!isRealPathInside(runsDir, runPaths.contextTaskOrderAbs)) {
    return undefined;
  }

  try {
    return readFileSync(runPaths.contextTaskOrderAbs, 'utf-8');
  } catch (error) {
    options?.onError?.(runPaths.contextTaskOrderAbs, error);
    return undefined;
  }
}
