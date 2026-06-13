/**
 * Pure utility functions for generating install summary information.
 *
 * Extracted to keep install summary parsing testable.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import type { StepProviderOptions } from '../../core/models/workflow-types.js';
import { mergeProviderOptions } from '../../infra/config/providerOptions.js';
import type { FacetResolutionContext } from '../../infra/config/loaders/workflowPackageScope.js';
import {
  type ProviderOptionsFileAccess,
  resolveWorkflowProviderOptionsWithHost,
} from '../../infra/config/loaders/workflowProviderOptionsResolver.js';
import type { ScopedProviderOptionsCandidateDirs } from '../../infra/config/loaders/providerOptionsLookupDirectories.js';

const log = createLogger('pack-summary');
const PACKAGE_ROOT = '/__takt_repertoire_package__';
export const PACKAGE_PROVIDER_OPTIONS_DIR = `${PACKAGE_ROOT}/provider-options`;

export interface EditWorkflowInfo {
  name: string;
  allowedTools: string[];
  hasEdit: boolean;
  requiredPermissionModes: string[];
}

interface PackageYaml {
  name: string;
  content: string;
  relativePath?: string;
}

export interface DetectEditWorkflowsOptions {
  providerOptionsCandidateDirs?: readonly string[];
  providerOptionsScopedCandidateDirs?: ScopedProviderOptionsCandidateDirs;
  fileAccess?: ProviderOptionsFileAccess;
  context?: FacetResolutionContext;
}

type YamlRecord = Record<string, unknown>;

interface RawSummaryStep {
  edit?: boolean;
  provider_options?: unknown;
  required_permission_mode?: string;
  promotion?: {
    provider_options?: unknown;
  }[];
  overrides?: {
    provider_options?: unknown;
  };
  parallel?: RawSummaryStep[];
}

interface PermissionStep {
  step: RawSummaryStep;
  providerOptions: StepProviderOptions | undefined;
}

function isRecord(value: unknown): value is YamlRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseYamlRecord(content: string, label: string): YamlRecord | undefined {
  try {
    const parsed = parseYaml(content);
    return isRecord(parsed) ? parsed : undefined;
  } catch (e) {
    log.debug(`YAML parse failed for ${label}: ${getErrorMessage(e)}`);
    return undefined;
  }
}

function normalizePackagePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function toPackageAbsolutePath(relativePath: string): string {
  return resolve(PACKAGE_ROOT, normalizePackagePath(relativePath));
}

const nodeFileAccess: ProviderOptionsFileAccess = {
  exists: (path) => existsSync(path),
  readText: (path) => readFileSync(path, 'utf-8'),
  realpath: (path) => realpathSync(path),
  isSymlink: (path) => lstatSync(path).isSymbolicLink(),
};

function isPathInsideDirectory(path: string, directory: string): boolean {
  const relativePath = relative(directory, path);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function isPackageVirtualPath(path: string): boolean {
  return isPathInsideDirectory(resolve(path), resolve(PACKAGE_ROOT));
}

function buildProviderOptionsFileAccess(
  providerOptionsYamls: PackageYaml[],
  fallbackFileAccess: ProviderOptionsFileAccess,
): ProviderOptionsFileAccess {
  const files = new Map<string, string>();
  for (const yaml of providerOptionsYamls) {
    const relativePath = normalizePackagePath(yaml.relativePath ?? `provider-options/${yaml.name}`);
    files.set(toPackageAbsolutePath(relativePath), yaml.content);
  }

  return {
    exists: (path) => {
      const resolvedPath = resolve(path);
      return files.has(resolvedPath) || (!isPackageVirtualPath(resolvedPath) && fallbackFileAccess.exists(resolvedPath));
    },
    readText: (path) => {
      const resolvedPath = resolve(path);
      const content = files.get(resolvedPath);
      if (content !== undefined) {
        return content;
      }
      if (!isPackageVirtualPath(resolvedPath)) {
        return fallbackFileAccess.readText(resolvedPath);
      }
      throw new Error(`Configuration error: provider_options.$ref not found: ${path}`);
    },
    realpath: (path) => {
      const resolvedPath = resolve(path);
      if (isPackageVirtualPath(resolvedPath)) {
        return resolvedPath;
      }
      return fallbackFileAccess.realpath(resolvedPath);
    },
    isSymlink: (path) => {
      const resolvedPath = resolve(path);
      if (isPackageVirtualPath(resolvedPath)) {
        return false;
      }
      return fallbackFileAccess.isSymlink?.(resolvedPath) === true;
    },
  };
}

function buildProviderOptionsCandidateDirs(options: DetectEditWorkflowsOptions | undefined): string[] {
  return [
    PACKAGE_PROVIDER_OPTIONS_DIR,
    ...(options?.providerOptionsCandidateDirs ?? []),
  ];
}

function assertProviderOptionsRecord(rawProviderOptions: unknown): Record<string, unknown> & { $ref?: string } {
  if (!isRecord(rawProviderOptions)) {
    throw new Error('Configuration error: provider_options must be a YAML object');
  }
  return rawProviderOptions as Record<string, unknown> & { $ref?: string };
}

function resolveProviderOptionsRecord(
  rawProviderOptions: unknown,
  workflowPath: string,
  fileAccess: ProviderOptionsFileAccess,
  candidateDirs: readonly string[],
  scopedCandidateDirs: ScopedProviderOptionsCandidateDirs | undefined,
  context: FacetResolutionContext | undefined,
): StepProviderOptions | undefined {
  if (rawProviderOptions === undefined) {
    return undefined;
  }
  return resolveWorkflowProviderOptionsWithHost(
    assertProviderOptionsRecord(rawProviderOptions),
    dirname(workflowPath),
    {
      rootDir: dirname(workflowPath),
      candidateDirs,
      scopedCandidateDirs,
      fileAccess,
      context,
    },
  );
}

function getAllowedTools(providerOptions: StepProviderOptions | undefined): string[] {
  return [
    providerOptions?.claude?.allowedTools,
    providerOptions?.opencode?.allowedTools,
  ].flatMap((tools) => (
    Array.isArray(tools) && tools.every((tool): tool is string => typeof tool === 'string') ? tools : []
  ));
}

function collectPermissionSteps(
  steps: RawSummaryStep[],
  inheritedProviderOptions: StepProviderOptions | undefined,
  resolveStepProviderOptions: (rawProviderOptions: unknown) => StepProviderOptions | undefined,
): PermissionStep[] {
  return steps.flatMap((step) => {
    const providerOptions = mergeProviderOptions(
      inheritedProviderOptions,
      resolveStepProviderOptions(step.provider_options),
    );
    return [
      { step, providerOptions },
      ...collectPermissionSteps(step.parallel ?? [], providerOptions, resolveStepProviderOptions),
    ];
  });
}

/**
 * Count facet files per type (personas, policies, knowledge, etc.)
 * and produce a human-readable summary string.
 *
 * @param facetRelativePaths - Paths relative to package root, starting with `facets/`
 */
export function summarizeFacetsByType(facetRelativePaths: string[]): string {
  const countsByType = new Map<string, number>();
  for (const path of facetRelativePaths) {
    const parts = path.split('/');
    if (parts.length >= 2 && parts[1]) {
      const type = parts[1];
      countsByType.set(type, (countsByType.get(type) ?? 0) + 1);
    }
  }
  return countsByType.size > 0
    ? Array.from(countsByType.entries()).map(([type, count]) => `${count} ${type}`).join(', ')
    : '0';
}

/**
 * Detect workflows that require permissions in any step.
 *
 * A step is considered permission-relevant when any of:
 * - `edit: true` is set
 * - `provider_options` has at least one provider allowed_tools entry
 * - `required_permission_mode` is set
 *
 * @param workflowYamls - Pre-read YAML content pairs. Invalid YAML is skipped (debug-logged).
 * @param providerOptionsYamls - Pre-read package provider-options YAML files used by provider_options.$ref.
 */
export function detectEditWorkflows(
  workflowYamls: PackageYaml[],
  providerOptionsYamls: PackageYaml[] = [],
  options?: DetectEditWorkflowsOptions,
): EditWorkflowInfo[] {
  const result: EditWorkflowInfo[] = [];
  const providerOptionsFileAccess = buildProviderOptionsFileAccess(
    providerOptionsYamls,
    options?.fileAccess ?? nodeFileAccess,
  );
  const providerOptionsCandidateDirs = buildProviderOptionsCandidateDirs(options);
  for (const { name, content, relativePath } of workflowYamls) {
    const raw = parseYamlRecord(content, `workflow ${name}`) as {
      workflow_config?: {
        provider_options?: unknown;
      };
      steps?: RawSummaryStep[];
    } | undefined;
    if (!raw) continue;

    const steps = raw?.steps ?? [];
    const workflowPath = toPackageAbsolutePath(relativePath ?? `workflows/${name}`);
    const workflowProviderOptions = resolveProviderOptionsRecord(
      raw?.workflow_config?.provider_options,
      workflowPath,
      providerOptionsFileAccess,
      providerOptionsCandidateDirs,
      options?.providerOptionsScopedCandidateDirs,
      options?.context,
    );
    const resolveStepProviderOptions = (providerOptions: unknown): StepProviderOptions | undefined =>
      resolveProviderOptionsRecord(
        providerOptions,
        workflowPath,
        providerOptionsFileAccess,
        providerOptionsCandidateDirs,
        options?.providerOptionsScopedCandidateDirs,
        options?.context,
      );
    const permissionSteps = collectPermissionSteps(
      steps,
      workflowProviderOptions,
      resolveStepProviderOptions,
    );
    const resolveAllowedTools = (entry: PermissionStep): string[] =>
      getAllowedTools(entry.providerOptions);
    const resolveRawAllowedTools = (providerOptions: unknown): string[] =>
      getAllowedTools(resolveStepProviderOptions(providerOptions));
    const resolvePromotionAllowedTools = (step: RawSummaryStep): string[] =>
      (step.promotion ?? []).flatMap((entry) => resolveRawAllowedTools(entry.provider_options));
    const resolveOverrideAllowedTools = (step: RawSummaryStep): string[] =>
      resolveRawAllowedTools(step.overrides?.provider_options);

    const hasEditableStep = permissionSteps.some(({ step }) => step.edit === true);
    const hasToolUsingStep = permissionSteps.some(entry =>
      resolveAllowedTools(entry).length > 0
      || resolvePromotionAllowedTools(entry.step).length > 0
      || resolveOverrideAllowedTools(entry.step).length > 0,
    );
    const hasPermissionControlledStep = permissionSteps.some(({ step }) => step.required_permission_mode != null);
    if (!hasEditableStep && !hasToolUsingStep && !hasPermissionControlledStep) continue;

    const allTools = new Set<string>();
    for (const entry of permissionSteps) {
      const stepTools = [
        ...resolveAllowedTools(entry),
        ...resolvePromotionAllowedTools(entry.step),
        ...resolveOverrideAllowedTools(entry.step),
      ];
      for (const tool of stepTools) {
        allTools.add(tool);
      }
    }
    const requiredPermissionModes: string[] = [];
    for (const { step } of permissionSteps) {
      if (step.required_permission_mode != null) {
        const mode = step.required_permission_mode;
        if (!requiredPermissionModes.includes(mode)) {
          requiredPermissionModes.push(mode);
        }
      }
    }
    result.push({
      name,
      allowedTools: Array.from(allTools),
      hasEdit: hasEditableStep,
      requiredPermissionModes,
    });
  }
  return result;
}

/**
 * Format warning lines for a single permission-relevant workflow.
 * Returns one line per warning (edit, provider_options allowed_tools, required_permission_mode).
 */
export function formatEditWorkflowWarnings(workflow: EditWorkflowInfo): string[] {
  const warnings: string[] = [];
  if (workflow.hasEdit) {
    const toolStr = workflow.allowedTools.length > 0
      ? `, provider_options.allowed_tools: [${workflow.allowedTools.join(', ')}]`
      : '';
    warnings.push(`\n   ⚠ ${workflow.name}: edit: true${toolStr}`);
  } else if (workflow.allowedTools.length > 0) {
    warnings.push(`\n   ⚠ ${workflow.name}: provider_options.allowed_tools: [${workflow.allowedTools.join(', ')}]`);
  }
  for (const mode of workflow.requiredPermissionModes) {
    warnings.push(`\n   ⚠ ${workflow.name}: required_permission_mode: ${mode}`);
  }
  return warnings;
}
