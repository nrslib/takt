/**
 * Reset user workflow categories overlay.
 */

import { resetWorkflowCategories, getWorkflowCategoriesPath } from '../../infra/config/global/workflowCategories.js';
import { header, success, info } from '../../shared/ui/index.js';

export async function resetCategoriesToDefault(cwd: string): Promise<void> {
  header('Reset Categories');

  resetWorkflowCategories(cwd);

  const userPath = getWorkflowCategoriesPath(cwd);
  success('User category overlay reset.');
  info(`  ${userPath}`);
}
