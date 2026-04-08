/**
 * Pure utility functions for generating install summary information.
 *
 * Extracted to enable unit testing without file I/O or system dependencies.
 */

import { parse as parseYaml } from 'yaml';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';

const log = createLogger('pack-summary');

export interface EditWorkflowInfo {
  name: string;
  allowedTools: string[];
  hasEdit: boolean;
  requiredPermissionModes: string[];
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
 * - `provider_options.claude.allowed_tools` has at least one entry
 * - `required_permission_mode` is set
 *
 * @param workflowYamls - Pre-read YAML content pairs. Invalid YAML is skipped (debug-logged).
 */
export function detectEditWorkflows(workflowYamls: Array<{ name: string; content: string }>): EditWorkflowInfo[] {
  const result: EditWorkflowInfo[] = [];
  for (const { name, content } of workflowYamls) {
    let raw: {
      workflow_config?: {
        provider_options?: { claude?: { allowed_tools?: string[] } };
      };
      steps?: {
        edit?: boolean;
        provider_options?: { claude?: { allowed_tools?: string[] } };
        required_permission_mode?: string;
      }[];
    } | null;
    try {
      raw = parseYaml(content) as typeof raw;
    } catch (e) {
      log.debug(`YAML parse failed for workflow ${name}: ${getErrorMessage(e)}`);
      continue;
    }
    const steps = raw?.steps ?? [];
    const workflowAllowedTools = raw?.workflow_config?.provider_options?.claude?.allowed_tools;
    const resolveAllowedTools = (step: typeof steps[number]): string[] =>
      step.provider_options?.claude?.allowed_tools ?? workflowAllowedTools ?? [];

    const hasEditableStep = steps.some(step => step.edit === true);
    const hasToolUsingStep = steps.some(step => resolveAllowedTools(step).length > 0);
    const hasPermissionControlledStep = steps.some(step => step.required_permission_mode != null);
    if (!hasEditableStep && !hasToolUsingStep && !hasPermissionControlledStep) continue;

    const allTools = new Set<string>();
    for (const step of steps) {
      for (const tool of resolveAllowedTools(step)) {
        allTools.add(tool);
      }
    }
    const requiredPermissionModes: string[] = [];
    for (const step of steps) {
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
 * Returns one line per warning (edit, provider_options.claude.allowed_tools, required_permission_mode).
 */
export function formatEditWorkflowWarnings(workflow: EditWorkflowInfo): string[] {
  const warnings: string[] = [];
  if (workflow.hasEdit) {
    const toolStr = workflow.allowedTools.length > 0
      ? `, provider_options.claude.allowed_tools: [${workflow.allowedTools.join(', ')}]`
      : '';
    warnings.push(`\n   ⚠ ${workflow.name}: edit: true${toolStr}`);
  } else if (workflow.allowedTools.length > 0) {
    warnings.push(`\n   ⚠ ${workflow.name}: provider_options.claude.allowed_tools: [${workflow.allowedTools.join(', ')}]`);
  }
  for (const mode of workflow.requiredPermissionModes) {
    warnings.push(`\n   ⚠ ${workflow.name}: required_permission_mode: ${mode}`);
  }
  return warnings;
}
