import { existsSync, readFileSync } from 'node:fs';
import { buildRunPaths } from './run-paths.js';

export interface ReadRunContextOrderContentOptions {
  readonly onError?: (orderPath: string, error: unknown) => void;
}

export function readRunContextOrderContent(
  cwd: string,
  slug: string,
  options?: ReadRunContextOrderContentOptions,
): string | undefined {
  const runPaths = buildRunPaths(cwd, slug);
  if (!existsSync(runPaths.contextTaskOrderAbs)) {
    return undefined;
  }

  try {
    return readFileSync(runPaths.contextTaskOrderAbs, 'utf-8');
  } catch (error) {
    options?.onError?.(runPaths.contextTaskOrderAbs, error);
    return undefined;
  }
}
