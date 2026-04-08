/**
 * Workflow categories file management.
 *
 * User category file is treated as overlay on top of builtin categories.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getGlobalConfigDir } from '../paths.js';
import { resolveWorkflowConfigValue } from '../resolveWorkflowConfigValue.js';

const INITIAL_USER_CATEGORIES_CONTENT = 'workflow_categories: {}\n';

function getDefaultWorkflowCategoriesPath(): string {
  return join(getGlobalConfigDir(), 'preferences', 'workflow-categories.yaml');
}

/** Get the path to the user's workflow categories file. */
export function getWorkflowCategoriesPath(cwd: string): string {
  const workflowCategoriesFile = resolveWorkflowConfigValue(cwd, 'workflowCategoriesFile');
  if (workflowCategoriesFile) {
    return workflowCategoriesFile;
  }
  return getDefaultWorkflowCategoriesPath();
}

/**
 * Reset user categories overlay file to initial content.
 */
export function resetWorkflowCategories(cwd: string): void {
  const userPath = getWorkflowCategoriesPath(cwd);
  const dir = dirname(userPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(userPath, INITIAL_USER_CATEGORIES_CONTENT, 'utf-8');
}
