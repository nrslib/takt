import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getWorkflowCategoriesPath } from '../global/workflowCategories.js';
import { getBuiltinWorkflowsDir } from '../paths.js';
import { getLanguageResourcesDir } from '../../resources/index.js';
import { resolveWorkflowConfigValues } from '../resolveWorkflowConfigValue.js';
import { BUILTIN_CATEGORY_NAME, type CategoryConfig } from './workflowCategoryTypes.js';
import { listBuiltinWorkflowNamesForDir } from './workflowDiscovery.js';
import {
  mergeWorkflowCategoryConfigs,
  parseWorkflowCategoryConfig,
  parseWorkflowCategoryOverlay,
  type WorkflowCategoryOverlay,
} from './workflowCategoryParser.js';

function loadCategoryConfigFromPath(path: string, sourceLabel: string): WorkflowCategoryOverlay | null {
  if (!existsSync(path)) {
    return null;
  }
  return parseWorkflowCategoryOverlay(parseYaml(readFileSync(path, 'utf-8')), sourceLabel);
}

export function getDefaultCategoriesPath(cwd: string): string {
  const { language } = resolveWorkflowConfigValues(cwd, ['language']);
  return join(getLanguageResourcesDir(language), 'workflow-categories.yaml');
}

export function loadDefaultCategories(cwd: string): CategoryConfig | null {
  const filePath = getDefaultCategoriesPath(cwd);
  if (!existsSync(filePath)) {
    return null;
  }
  return parseWorkflowCategoryConfig(parseYaml(readFileSync(filePath, 'utf-8')), filePath);
}

export function getWorkflowCategories(cwd: string): CategoryConfig | null {
  const builtinConfig = loadDefaultCategories(cwd);
  if (!builtinConfig) {
    return null;
  }

  const userPath = getWorkflowCategoriesPath(cwd);
  const userConfig = loadCategoryConfigFromPath(userPath, userPath);
  return mergeWorkflowCategoryConfigs(builtinConfig, userConfig, BUILTIN_CATEGORY_NAME);
}

function listBuiltinWorkflowNamesForLanguage(language: 'en' | 'ja'): string[] {
  return listBuiltinWorkflowNamesForDir(getBuiltinWorkflowsDir(language));
}

export function resolveIgnoredWorkflows(cwd: string): Set<string> {
  const globalConfig = resolveWorkflowConfigValues(cwd, ['enableBuiltinWorkflows', 'disabledBuiltins', 'language']);
  const ignoredWorkflows = new Set<string>();

  if (globalConfig.enableBuiltinWorkflows === false) {
    for (const name of listBuiltinWorkflowNamesForLanguage(globalConfig.language)) {
      ignoredWorkflows.add(name);
    }
    return ignoredWorkflows;
  }

  for (const name of globalConfig.disabledBuiltins ?? []) {
    ignoredWorkflows.add(name);
  }
  return ignoredWorkflows;
}
