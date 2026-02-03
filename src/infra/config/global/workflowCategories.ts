/**
 * Workflow categories management (separate from config.yaml)
 *
 * Categories are stored in a configurable location (default: ~/.takt/preferences/workflow-categories.yaml)
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getGlobalConfigDir } from '../paths.js';
import { loadGlobalConfig } from './globalConfig.js';
import type { WorkflowCategoryConfigNode } from '../../../core/models/index.js';

interface WorkflowCategoriesFile {
  categories?: WorkflowCategoryConfigNode;
  show_others_category?: boolean;
  others_category_name?: string;
}

function getDefaultWorkflowCategoriesPath(): string {
  return join(getGlobalConfigDir(), 'preferences', 'workflow-categories.yaml');
}

function getWorkflowCategoriesPath(): string {
  try {
    const config = loadGlobalConfig();
    if (config.workflowCategoriesFile) {
      return config.workflowCategoriesFile;
    }
  } catch {
    // Ignore errors, use default
  }
  return getDefaultWorkflowCategoriesPath();
}

function loadWorkflowCategoriesFile(): WorkflowCategoriesFile {
  const categoriesPath = getWorkflowCategoriesPath();
  if (!existsSync(categoriesPath)) {
    return {};
  }

  try {
    const content = readFileSync(categoriesPath, 'utf-8');
    const parsed = parseYaml(content);
    if (parsed && typeof parsed === 'object') {
      return parsed as WorkflowCategoriesFile;
    }
  } catch {
    // Ignore parse errors
  }

  return {};
}

function saveWorkflowCategoriesFile(data: WorkflowCategoriesFile): void {
  const categoriesPath = getWorkflowCategoriesPath();
  const dir = dirname(categoriesPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const content = stringifyYaml(data, { indent: 2 });
  writeFileSync(categoriesPath, content, 'utf-8');
}

/** Get workflow categories configuration */
export function getWorkflowCategoriesConfig(): WorkflowCategoryConfigNode | undefined {
  const data = loadWorkflowCategoriesFile();
  return data.categories;
}

/** Set workflow categories configuration */
export function setWorkflowCategoriesConfig(categories: WorkflowCategoryConfigNode): void {
  const data = loadWorkflowCategoriesFile();
  data.categories = categories;
  saveWorkflowCategoriesFile(data);
}

/** Get show others category flag */
export function getShowOthersCategory(): boolean | undefined {
  const data = loadWorkflowCategoriesFile();
  return data.show_others_category;
}

/** Set show others category flag */
export function setShowOthersCategory(show: boolean): void {
  const data = loadWorkflowCategoriesFile();
  data.show_others_category = show;
  saveWorkflowCategoriesFile(data);
}

/** Get others category name */
export function getOthersCategoryName(): string | undefined {
  const data = loadWorkflowCategoriesFile();
  return data.others_category_name;
}

/** Set others category name */
export function setOthersCategoryName(name: string): void {
  const data = loadWorkflowCategoriesFile();
  data.others_category_name = name;
  saveWorkflowCategoriesFile(data);
}
