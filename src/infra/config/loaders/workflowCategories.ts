/**
 * Workflow category configuration loader and helpers.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod/v4';
import { getProjectConfigPath } from '../paths.js';
import { getLanguage, getBuiltinWorkflowsEnabled, getDisabledBuiltins } from '../global/globalConfig.js';
import {
  getWorkflowCategoriesConfig,
  getShowOthersCategory,
  getOthersCategoryName,
} from '../global/workflowCategories.js';
import { getLanguageResourcesDir } from '../../resources/index.js';
import { listBuiltinWorkflowNames } from './workflowResolver.js';
import type { WorkflowSource, WorkflowWithSource } from './workflowResolver.js';

const CategoryConfigSchema = z.object({
  workflow_categories: z.record(z.string(), z.unknown()).optional(),
  show_others_category: z.boolean().optional(),
  others_category_name: z.string().min(1).optional(),
}).passthrough();

export interface WorkflowCategoryNode {
  name: string;
  workflows: string[];
  children: WorkflowCategoryNode[];
}

export interface CategoryConfig {
  workflowCategories: WorkflowCategoryNode[];
  showOthersCategory: boolean;
  othersCategoryName: string;
}

export interface CategorizedWorkflows {
  categories: WorkflowCategoryNode[];
  builtinCategories: WorkflowCategoryNode[];
  allWorkflows: Map<string, WorkflowWithSource>;
  missingWorkflows: MissingWorkflow[];
}

export interface MissingWorkflow {
  categoryPath: string[];
  workflowName: string;
}

interface RawCategoryConfig {
  workflow_categories?: Record<string, unknown>;
  show_others_category?: boolean;
  others_category_name?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseWorkflows(raw: unknown, sourceLabel: string, path: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`workflows must be an array in ${sourceLabel} at ${path.join(' > ')}`);
  }
  const workflows: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`workflow name must be a non-empty string in ${sourceLabel} at ${path.join(' > ')}`);
    }
    workflows.push(item);
  }
  return workflows;
}

function parseCategoryNode(
  name: string,
  raw: unknown,
  sourceLabel: string,
  path: string[],
): WorkflowCategoryNode {
  if (!isRecord(raw)) {
    throw new Error(`category "${name}" must be an object in ${sourceLabel} at ${path.join(' > ')}`);
  }

  const workflows = parseWorkflows(raw.workflows, sourceLabel, path);
  const children: WorkflowCategoryNode[] = [];

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'workflows') continue;
    if (!isRecord(value)) {
      throw new Error(`category "${key}" must be an object in ${sourceLabel} at ${[...path, key].join(' > ')}`);
    }
    children.push(parseCategoryNode(key, value, sourceLabel, [...path, key]));
  }

  return { name, workflows, children };
}

function parseCategoryTree(raw: unknown, sourceLabel: string): WorkflowCategoryNode[] {
  if (!isRecord(raw)) {
    throw new Error(`workflow_categories must be an object in ${sourceLabel}`);
  }
  const categories: WorkflowCategoryNode[] = [];
  for (const [name, value] of Object.entries(raw)) {
    categories.push(parseCategoryNode(name, value, sourceLabel, [name]));
  }
  return categories;
}

function parseCategoryConfig(raw: unknown, sourceLabel: string): CategoryConfig | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const hasWorkflowCategories = Object.prototype.hasOwnProperty.call(raw, 'workflow_categories');
  if (!hasWorkflowCategories) {
    return null;
  }

  const parsed = CategoryConfigSchema.parse(raw) as RawCategoryConfig;
  if (!parsed.workflow_categories) {
    throw new Error(`workflow_categories is required in ${sourceLabel}`);
  }

  const showOthersCategory = parsed.show_others_category === undefined
    ? true
    : parsed.show_others_category;

  const othersCategoryName = parsed.others_category_name === undefined
    ? 'Others'
    : parsed.others_category_name;

  return {
    workflowCategories: parseCategoryTree(parsed.workflow_categories, sourceLabel),
    showOthersCategory,
    othersCategoryName,
  };
}

function loadCategoryConfigFromPath(path: string, sourceLabel: string): CategoryConfig | null {
  if (!existsSync(path)) {
    return null;
  }
  const content = readFileSync(path, 'utf-8');
  const raw = parseYaml(content);
  return parseCategoryConfig(raw, sourceLabel);
}

/**
 * Load default categories from builtin resource file.
 * Returns null if file doesn't exist or has no workflow_categories.
 */
export function loadDefaultCategories(): CategoryConfig | null {
  const lang = getLanguage();
  const filePath = join(getLanguageResourcesDir(lang), 'default-categories.yaml');
  return loadCategoryConfigFromPath(filePath, filePath);
}

/**
 * Get effective workflow categories configuration.
 * Priority: user config -> project config -> default categories.
 */
export function getWorkflowCategories(cwd: string): CategoryConfig | null {
  // Check user config from separate file (~/.takt/workflow-categories.yaml)
  const userCategoriesNode = getWorkflowCategoriesConfig();
  if (userCategoriesNode) {
    const showOthersCategory = getShowOthersCategory() ?? true;
    const othersCategoryName = getOthersCategoryName() ?? 'Others';
    return {
      workflowCategories: parseCategoryTree(userCategoriesNode, 'user config'),
      showOthersCategory,
      othersCategoryName,
    };
  }

  const projectConfig = loadCategoryConfigFromPath(getProjectConfigPath(cwd), 'project config');
  if (projectConfig) {
    return projectConfig;
  }

  return loadDefaultCategories();
}

function collectMissingWorkflows(
  categories: WorkflowCategoryNode[],
  allWorkflows: Map<string, WorkflowWithSource>,
  ignoreWorkflows: Set<string>,
): MissingWorkflow[] {
  const missing: MissingWorkflow[] = [];
  const visit = (nodes: WorkflowCategoryNode[], path: string[]): void => {
    for (const node of nodes) {
      const nextPath = [...path, node.name];
      for (const workflowName of node.workflows) {
        if (ignoreWorkflows.has(workflowName)) continue;
        if (!allWorkflows.has(workflowName)) {
          missing.push({ categoryPath: nextPath, workflowName });
        }
      }
      if (node.children.length > 0) {
        visit(node.children, nextPath);
      }
    }
  };

  visit(categories, []);
  return missing;
}

function buildCategoryTreeForSource(
  categories: WorkflowCategoryNode[],
  allWorkflows: Map<string, WorkflowWithSource>,
  sourceFilter: (source: WorkflowSource) => boolean,
  categorized: Set<string>,
): WorkflowCategoryNode[] {
  const result: WorkflowCategoryNode[] = [];

  for (const node of categories) {
    const workflows: string[] = [];
    for (const workflowName of node.workflows) {
      const entry = allWorkflows.get(workflowName);
      if (!entry) continue;
      if (!sourceFilter(entry.source)) continue;
      workflows.push(workflowName);
      categorized.add(workflowName);
    }

    const children = buildCategoryTreeForSource(node.children, allWorkflows, sourceFilter, categorized);
    if (workflows.length > 0 || children.length > 0) {
      result.push({ name: node.name, workflows, children });
    }
  }

  return result;
}

function appendOthersCategory(
  categories: WorkflowCategoryNode[],
  allWorkflows: Map<string, WorkflowWithSource>,
  categorized: Set<string>,
  sourceFilter: (source: WorkflowSource) => boolean,
  othersCategoryName: string,
): WorkflowCategoryNode[] {
  if (categories.some((node) => node.name === othersCategoryName)) {
    return categories;
  }

  const uncategorized: string[] = [];
  for (const [workflowName, entry] of allWorkflows.entries()) {
    if (!sourceFilter(entry.source)) continue;
    if (categorized.has(workflowName)) continue;
    uncategorized.push(workflowName);
  }

  if (uncategorized.length === 0) {
    return categories;
  }

  return [...categories, { name: othersCategoryName, workflows: uncategorized, children: [] }];
}

/**
 * Build categorized workflows map from configuration.
 */
export function buildCategorizedWorkflows(
  allWorkflows: Map<string, WorkflowWithSource>,
  config: CategoryConfig,
): CategorizedWorkflows {
  const ignoreMissing = new Set<string>();
  if (!getBuiltinWorkflowsEnabled()) {
    for (const name of listBuiltinWorkflowNames({ includeDisabled: true })) {
      ignoreMissing.add(name);
    }
  } else {
    for (const name of getDisabledBuiltins()) {
      ignoreMissing.add(name);
    }
  }

  const missingWorkflows = collectMissingWorkflows(
    config.workflowCategories,
    allWorkflows,
    ignoreMissing,
  );

  const isBuiltin = (source: WorkflowSource): boolean => source === 'builtin';
  const isCustom = (source: WorkflowSource): boolean => source !== 'builtin';

  const categorizedCustom = new Set<string>();
  const categories = buildCategoryTreeForSource(
    config.workflowCategories,
    allWorkflows,
    isCustom,
    categorizedCustom,
  );

  const categorizedBuiltin = new Set<string>();
  const builtinCategories = buildCategoryTreeForSource(
    config.workflowCategories,
    allWorkflows,
    isBuiltin,
    categorizedBuiltin,
  );

  const finalCategories = config.showOthersCategory
    ? appendOthersCategory(
      categories,
      allWorkflows,
      categorizedCustom,
      isCustom,
      config.othersCategoryName,
    )
    : categories;

  const finalBuiltinCategories = config.showOthersCategory
    ? appendOthersCategory(
      builtinCategories,
      allWorkflows,
      categorizedBuiltin,
      isBuiltin,
      config.othersCategoryName,
    )
    : builtinCategories;

  return {
    categories: finalCategories,
    builtinCategories: finalBuiltinCategories,
    allWorkflows,
    missingWorkflows,
  };
}

function findWorkflowCategoryPaths(
  workflow: string,
  categories: WorkflowCategoryNode[],
  prefix: string[],
  results: string[],
): void {
  for (const node of categories) {
    const path = [...prefix, node.name];
    if (node.workflows.includes(workflow)) {
      results.push(path.join(' / '));
    }
    if (node.children.length > 0) {
      findWorkflowCategoryPaths(workflow, node.children, path, results);
    }
  }
}

/**
 * Find which categories contain a given workflow (for duplicate indication).
 */
export function findWorkflowCategories(
  workflow: string,
  categories: WorkflowCategoryNode[],
): string[] {
  const result: string[] = [];
  findWorkflowCategoryPaths(workflow, categories, [], result);
  return result;
}
