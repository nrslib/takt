import { join } from 'node:path';
import type { Language } from '../../../core/models/index.js';
import {
  getBuiltinCompanionsDir,
  getGlobalCompanionsDir,
  getProjectCompanionsDir,
} from '../paths.js';

export function buildCompanionLookupDirs(input: {
  projectDir: string;
  userDir: string;
  builtinDir: string;
}): string[] {
  return [
    join(input.projectDir, '.takt', 'companions'),
    join(input.userDir, 'companions'),
    join(input.builtinDir, 'companions'),
  ];
}

export function buildConfiguredCompanionLookupDirs(
  projectDir: string,
  language: Language,
  resourceRoot?: string,
): string[] {
  if (resourceRoot !== undefined) {
    return [join(resourceRoot, 'companions')];
  }
  return [
    getProjectCompanionsDir(projectDir),
    getGlobalCompanionsDir(),
    getBuiltinCompanionsDir(language),
  ];
}
