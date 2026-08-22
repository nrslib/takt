import { WorkflowCategoryOverlaySchema } from '../../../core/models/index.js';
import type { CategoryConfig, WorkflowCategoryNode, WorkflowDescriptions } from './workflowCategoryTypes.js';

interface RawCategoryConfig {
  workflow_categories?: Record<string, unknown>;
  show_others_category?: boolean;
  others_category_name?: string;
}

interface ParsedCategoryNode {
  name: string;
  workflows: string[];
  /** Descriptions declared inline by this node's own workflow entries (`- name: description`). */
  workflowDescriptions: Record<string, string>;
  children: ParsedCategoryNode[];
}

interface ParsedCategoryConfig {
  workflowCategories?: ParsedCategoryNode[];
  workflowDescriptions?: WorkflowDescriptions;
  showOthersCategory?: boolean;
  othersCategoryName?: string;
}

export interface WorkflowCategoryOverlay {
  workflowCategories?: WorkflowCategoryNode[];
  workflowDescriptions?: WorkflowDescriptions;
  showOthersCategory?: boolean;
  othersCategoryName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function addDescription(
  descriptions: Record<string, string>,
  workflowName: string,
  description: string,
  sourceLabel: string,
): void {
  const existing = descriptions[workflowName];
  if (existing !== undefined && existing !== description) {
    throw new Error(`conflicting descriptions for workflow "${workflowName}" in ${sourceLabel}`);
  }
  descriptions[workflowName] = description;
}

/**
 * Parse a `workflows:` list. Each entry is either a plain workflow name or a single-pair
 * `{ name: description }` map that also declares the workflow's selection-label description.
 */
function parseWorkflowEntries(
  raw: unknown,
  sourceLabel: string,
  path: string[],
): { names: string[]; descriptions: Record<string, string> } {
  if (raw === undefined) {
    return { names: [], descriptions: {} };
  }
  if (!Array.isArray(raw)) {
    throw new Error(`workflows must be an array in ${sourceLabel} at ${path.join(' > ')}`);
  }

  const names: string[] = [];
  const descriptions: Record<string, string> = {};
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim().length === 0) {
        throw new Error(`name must be a non-empty string in ${sourceLabel} at ${path.join(' > ')}`);
      }
      names.push(item);
      continue;
    }
    if (!isRecord(item)) {
      throw new Error(`workflow entry must be a string or a single-pair map in ${sourceLabel} at ${path.join(' > ')}`);
    }
    const pairs = Object.entries(item);
    if (pairs.length !== 1) {
      throw new Error(`workflow entry map must have exactly one key in ${sourceLabel} at ${path.join(' > ')}`);
    }
    const [name, description] = pairs[0]!;
    if (name.trim().length === 0) {
      throw new Error(`name must be a non-empty string in ${sourceLabel} at ${path.join(' > ')}`);
    }
    if (typeof description !== 'string' || description.trim().length === 0) {
      throw new Error(
        `description must be a non-empty string in ${sourceLabel} at ${path.join(' > ')} > ${name}`,
      );
    }
    names.push(name);
    addDescription(descriptions, name, description, sourceLabel);
  }
  return { names, descriptions };
}

function parseWorkflows(
  raw: Record<string, unknown>,
  sourceLabel: string,
  path: string[],
): { names: string[]; descriptions: Record<string, string> } {
  return Object.prototype.hasOwnProperty.call(raw, 'workflows')
    ? parseWorkflowEntries(raw.workflows, sourceLabel, path)
    : { names: [], descriptions: {} };
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

  const { names: workflows, descriptions } = parseWorkflows(raw, sourceLabel, path);
  const children: ParsedCategoryNode[] = [];

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'workflows') {
      continue;
    }
    if (!isRecord(value)) {
      throw new Error(`category "${key}" must be an object in ${sourceLabel} at ${[...path, key].join(' > ')}`);
    }
    children.push(parseCategoryNode(key, value, sourceLabel, [...path, key]));
  }

  return { name, workflows, workflowDescriptions: descriptions, children };
}

function parseCategoryTree(raw: unknown, sourceLabel: string, rootKeyLabel: string): ParsedCategoryNode[] {
  if (!isRecord(raw)) {
    throw new Error(`${rootKeyLabel} must be an object in ${sourceLabel}`);
  }
  return Object.entries(raw).map(([name, value]) =>
    parseCategoryNode(name, value, sourceLabel, [name]));
}

function collectTreeDescriptions(
  nodes: ParsedCategoryNode[],
  sourceLabel: string,
): Record<string, string> {
  const descriptions: Record<string, string> = {};
  const visit = (node: ParsedCategoryNode): void => {
    for (const [name, description] of Object.entries(node.workflowDescriptions)) {
      addDescription(descriptions, name, description, sourceLabel);
    }
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return descriptions;
}

function parseCategoryConfig(raw: unknown, sourceLabel: string): ParsedCategoryConfig | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const parsed = WorkflowCategoryOverlaySchema.parse(raw) as RawCategoryConfig;

  const result: ParsedCategoryConfig = {};
  const inlineDescriptions: Record<string, string> = {};
  if (Object.prototype.hasOwnProperty.call(parsed, 'workflow_categories')) {
    if (!parsed.workflow_categories) {
      throw new Error(`workflow_categories must be an object in ${sourceLabel}`);
    }
    result.workflowCategories = parseCategoryTree(parsed.workflow_categories, sourceLabel, 'workflow_categories');
    Object.assign(inlineDescriptions, collectTreeDescriptions(result.workflowCategories, sourceLabel));
  }
  if (Object.keys(inlineDescriptions).length > 0) {
    result.workflowDescriptions = inlineDescriptions;
  }
  if (parsed.show_others_category !== undefined) {
    result.showOthersCategory = parsed.show_others_category;
  }
  if (parsed.others_category_name !== undefined) {
    result.othersCategoryName = parsed.others_category_name;
  }

  if (
    result.workflowCategories === undefined
    && result.workflowDescriptions === undefined
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
    workflowDescriptions: parsed.workflowDescriptions,
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
    workflowDescriptions: parsed.workflowDescriptions,
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
    workflowDescriptions: mergeWorkflowDescriptions(
      builtinConfig.workflowDescriptions,
      userConfig?.workflowDescriptions,
    ),
  };
}

export function mergeWorkflowDescriptions(
  builtinDescriptions: WorkflowDescriptions | undefined,
  userDescriptions: WorkflowDescriptions | undefined,
): WorkflowDescriptions {
  return {
    ...(builtinDescriptions ?? {}),
    ...(userDescriptions ?? {}),
  };
}
