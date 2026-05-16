import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { getGlobalConfigDir } from '../global/globalConfigPaths.js';
import { getProjectConfigDir } from './projectConfigPaths.js';

function normalizeConfigDirPath(dirPath: string): string {
  const absolutePath = resolve(dirPath);
  if (existsSync(absolutePath)) {
    return realpathSync(absolutePath);
  }

  const missingSegments: string[] = [];
  let existingPath = absolutePath;

  while (!existsSync(existingPath)) {
    const parentPath = dirname(existingPath);
    if (parentPath === existingPath) {
      break;
    }
    missingSegments.unshift(basename(existingPath));
    existingPath = parentPath;
  }

  const resolvedExistingPath = realpathSync(existingPath);
  if (missingSegments.length === 0) {
    return resolvedExistingPath;
  }

  return join(resolvedExistingPath, ...missingSegments);
}

export function isProjectConfigEnabled(projectDir: string): boolean {
  return normalizeConfigDirPath(getProjectConfigDir(projectDir))
    !== normalizeConfigDirPath(getGlobalConfigDir());
}

export function getProjectConfigDirIfEnabled(projectDir: string): string | undefined {
  if (!isProjectConfigEnabled(projectDir)) {
    return undefined;
  }

  return getProjectConfigDir(projectDir);
}
