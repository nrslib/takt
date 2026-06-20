/**
 * takt repertoire remove — remove an installed repertoire package.
 */

import { rmSync, existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { validateScopeOwner, validateScopeRepo } from 'faceted-prompting';
import {
  getRepertoireDir,
  getRepertoirePackageDir,
  getGlobalWorkflowsDir,
  getProjectWorkflowsDir,
  getGlobalProviderOptionsDir,
  getProjectProviderOptionsDir,
} from '../../infra/config/paths.js';
import { getWorkflowCategoriesPath } from '../../infra/config/global/index.js';
import { findScopeReferences, shouldRemoveOwnerDir } from '../../features/repertoire/remove.js';
import { confirm } from '../../shared/prompt/index.js';
import { info, success } from '../../shared/ui/index.js';

function isPathInsideDirectory(path: string, directory: string): boolean {
  const relativePath = relative(directory, path);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function assertPackageDirInsideRepertoire(packageDir: string, repertoireDir: string, scope: string): void {
  const realPackageDir = realpathSync(packageDir);
  const realRepertoireDir = realpathSync(repertoireDir);
  if (!isPathInsideDirectory(realPackageDir, realRepertoireDir)) {
    throw new Error(`Invalid scope: "${scope}". Package path escapes repertoire directory`);
  }
}

export async function repertoireRemoveCommand(scope: string): Promise<void> {
  if (!scope.startsWith('@')) {
    throw new Error(`Invalid scope: "${scope}". Expected @{owner}/{repo}`);
  }
  const withoutAt = scope.slice(1);
  const slashIdx = withoutAt.indexOf('/');
  if (slashIdx < 0) {
    throw new Error(`Invalid scope: "${scope}". Expected @{owner}/{repo}`);
  }
  const owner = withoutAt.slice(0, slashIdx);
  const repo = withoutAt.slice(slashIdx + 1);
  validateScopeOwner(owner);
  validateScopeRepo(repo);

  const repertoireDir = getRepertoireDir();
  const packageDir = getRepertoirePackageDir(owner, repo);

  if (!existsSync(packageDir)) {
    throw new Error(`Package not found: ${scope}`);
  }

  const refs = findScopeReferences(scope, {
    workflowDirs: [getGlobalWorkflowsDir(), getProjectWorkflowsDir(process.cwd())],
    providerOptionsDirs: [getGlobalProviderOptionsDir(), getProjectProviderOptionsDir(process.cwd())],
    categoriesFiles: [getWorkflowCategoriesPath(process.cwd())],
  });
  if (refs.length > 0) {
    info(`⚠ 以下のファイルが ${scope} を参照しています:`);
    for (const ref of refs) {
      info(`  ${ref.filePath}`);
    }
  }

  const confirmed = await confirm(`${scope} を削除しますか？`, false);
  if (!confirmed) {
    info('キャンセルしました');
    return;
  }

  assertPackageDirInsideRepertoire(packageDir, repertoireDir, scope);
  rmSync(packageDir, { recursive: true, force: true });

  const ownerDir = join(repertoireDir, `@${owner}`);
  if (shouldRemoveOwnerDir(ownerDir, repo)) {
    rmSync(ownerDir, { recursive: true, force: true });
  }

  success(`${scope} を削除しました`);
}
