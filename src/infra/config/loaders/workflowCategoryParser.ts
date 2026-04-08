import { z } from 'zod/v4';
import type { CategoryConfig, WorkflowCategoryNode } from './workflowCategoryTypes.js';

const CategoryConfigSchema = z.object({
  workflow_categories: z.record(z.string(), z.unknown()).optional(),
  show_others_category: z.boolean().optional(),
  others_category_name: z.string().min(1).optional(),
}).passthrough();

const REMOVED_CATEGORY_ROOT_KEY = 'p' + 'iece_categories';

interface RawCategoryConfig {
  workflow_categories?: Record<string, unknown>;
  show_others_category?: boolean;
  others_category_name?: string;
}

interface ParsedCategoryNode {
  name: string;
  workflows: string[];
  children: ParsedCategoryNode[];
}

interface ParsedCategoryConfig {
  workflowCategories?: ParsedCategoryNode[];
  showOthersCategory?: boolean;
  othersCategoryName?: string;
}

export interface WorkflowCategoryOverlay {
  workflowCategories?: WorkflowCategoryNode[];
  showOthersCategory?: boolean;
  othersCategoryName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseStringNameList(raw: unknown, sourceLabel: string, path: string[]): string[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(`workflows must be an array in ${sourceLabel} at ${path.join(' > ')}`);
  }

  const names: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`name must be a non-empty string in ${sourceLabel} at ${path.join(' > ')}`);
    }
    names.push(item);
  }
  return names;
}

function parseWorkflows(raw: Record<string, unknown>, sourceLabel: string, path: string[]): string[] {
  if (Object.prototype.hasOwnProperty.call(raw, 'pieces')) {
    throw new Error(`"pieces" has been removed. Use "workflows" instead (${sourceLabel} at ${path.join(' > ')})`);
  }
  return Object.prototype.hasOwnProperty.call(raw, 'workflows')
    ? parseStringNameList(raw.workflows, sourceLabel, path)
    : [];
}

function parseCategoryNode(
  name: string,
  raw: unknown,
  sourceLabel: string,
  path: string[],
): ParsedCategoryNode {
  if (!isRecord(raw)) {
    throw new Error(`category "${name}" must be an object in ${sourceLabel} at ${path.join(' > ')}`);
  }

  const workflows = parseWorkflows(raw, sourceLabel, path);
  const children: ParsedCategoryNode[] = [];

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'workflows') {
      continue;
    }
    if (key === 'pieces') {
      throw new Error(`"pieces" has been removed. Use "workflows" instead (${sourceLabel} at ${path.join(' > ')})`);
    }
    if (!isRecord(value)) {
      throw new Error(`category "${key}" must be an object in ${sourceLabel} at ${[...path, key].join(' > ')}`);
    }
    children.push(parseCategoryNode(key, value, sourceLabel, [...path, key]));
  }

  return { name, workflows, children };
}

function parseCategoryTree(raw: unknown, sourceLabel: string, rootKeyLabel: string): ParsedCategoryNode[] {
  if (!isRecord(raw)) {
    throw new Error(`${rootKeyLabel} must be an object in ${sourceLabel}`);
  }
  return Object.entries(raw).map(([name, value]) =>
    parseCategoryNode(name, value, sourceLabel, [name]));
}

function parseCategoryConfig(raw: unknown, sourceLabel: string): ParsedCategoryConfig | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const parsed = CategoryConfigSchema.parse(raw) as RawCategoryConfig;
  const rawConfig = raw as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rawConfig, REMOVED_CATEGORY_ROOT_KEY)) {
    throw new Error(`A removed legacy category root key was found. Use "workflow_categories" instead (${sourceLabel})`);
  }

  const result: ParsedCategoryConfig = {};
  if (Object.prototype.hasOwnProperty.call(parsed, 'workflow_categories')) {
    if (!parsed.workflow_categories) {
      throw new Error(`workflow_categories must be an object in ${sourceLabel}`);
    }
    result.workflowCategories = parseCategoryTree(parsed.workflow_categories, sourceLabel, 'workflow_categories');
  }
  if (parsed.show_others_category !== undefined) {
    result.showOthersCategory = parsed.show_others_category;
  }
  if (parsed.others_category_name !== undefined) {
    result.othersCategoryName = parsed.others_category_name;
  }

  if (
    result.workflowCategories === undefined
    && result.showOthersCategory === undefined
    && result.othersCategoryName === undefined
  ) {
    return null;
  }
  return result;
}

function convertParsedNodes(nodes: ParsedCategoryNode[]): WorkflowCategoryNode[] {
  return nodes.map((node) => ({
    name: node.name,
    workflows: node.workflows,
    children: convertParsedNodes(node.children),
  }));
}

export function parseWorkflowCategoryOverlay(raw: unknown, sourceLabel: string): WorkflowCategoryOverlay | null {
  const parsed = parseCategoryConfig(raw, sourceLabel);
  if (!parsed) {
    return null;
  }
  return {
    workflowCategories: parsed.workflowCategories
      ? convertParsedNodes(parsed.workflowCategories)
      : undefined,
    showOthersCategory: parsed.showOthersCategory,
    othersCategoryName: parsed.othersCategoryName,
  };
}

export function parseWorkflowCategoryConfig(raw: unknown, sourceLabel: string): CategoryConfig | null {
  const parsed = parseWorkflowCategoryOverlay(raw, sourceLabel);
  if (!parsed?.workflowCategories) {
    return null;
  }

  return {
    workflowCategories: parsed.workflowCategories,
    builtinWorkflowCategories: parsed.workflowCategories,
    userWorkflowCategories: [],
    hasUserCategories: false,
    showOthersCategory: parsed.showOthersCategory ?? true,
    othersCategoryName: parsed.othersCategoryName ?? 'Others',
  };
}

export function mergeWorkflowCategoryConfigs(
  builtinConfig: CategoryConfig,
  userConfig: WorkflowCategoryOverlay | null,
  builtinCategoryName: string,
): CategoryConfig {
  const userWorkflowCategories = userConfig?.workflowCategories ?? [];
  const builtinWorkflowCategories = builtinConfig.workflowCategories;
  const hasUserCategories = userWorkflowCategories.length > 0;
  const workflowCategories = hasUserCategories
    ? [
      ...userWorkflowCategories,
      {
        name: builtinCategoryName,
        workflows: [],
        children: builtinWorkflowCategories,
      },
    ]
    : builtinWorkflowCategories;

  return {
    workflowCategories,
    builtinWorkflowCategories,
    userWorkflowCategories,
    hasUserCategories,
    showOthersCategory: userConfig?.showOthersCategory ?? builtinConfig.showOthersCategory,
    othersCategoryName: userConfig?.othersCategoryName ?? builtinConfig.othersCategoryName,
  };
}
