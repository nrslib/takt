import type { ManagerRuntimeAssignmentsConfig } from '../../core/models/config-types.js';
import { getGlobalConfigDir, getProjectConfigDir } from '../../infra/config/paths.js';
import { resolveInvocationRuntimeProviderFileWithOrigins } from '../../infra/config/runtime-provider/invocation.js';

export interface ManagerRuntimeAssignment {
  name: string;
  usageDescription?: string;
}

export function resolveManagerRuntimeAssignmentSelection(
  cwd: string,
  config: { runtimeAssignments?: ManagerRuntimeAssignmentsConfig },
): { runtimeAssignments: ManagerRuntimeAssignment[]; missingRuntimeAssignments: string[] } {
  const entries = new Map<string, string | undefined>();
  for (const entry of config.runtimeAssignments ?? []) {
    if (typeof entry === 'string') entries.set(entry, undefined);
    else for (const [name, description] of Object.entries(entry)) entries.set(name, description);
  }
  if (entries.size === 0) {
    return { runtimeAssignments: [], missingRuntimeAssignments: [] };
  }
  const defined = resolveInvocationRuntimeProviderFileWithOrigins({
    globalConfigDir: getGlobalConfigDir(),
    projectConfigDir: getProjectConfigDir(cwd),
  }).runtimeFile?.provider?.assignments ?? {};
  const runtimeAssignments: ManagerRuntimeAssignment[] = [];
  const missingRuntimeAssignments: string[] = [];
  for (const [name, usageDescription] of entries) {
    if (!Object.hasOwn(defined, name)) missingRuntimeAssignments.push(name);
    else runtimeAssignments.push({ name, ...(usageDescription === undefined ? {} : { usageDescription }) });
  }
  return { runtimeAssignments, missingRuntimeAssignments };
}
