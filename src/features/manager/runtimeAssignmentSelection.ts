import type { ManagerRuntimeAssignmentsConfig } from '../../core/models/config-types.js';
import { getGlobalConfigDir, getProjectConfigDir } from '../../infra/config/paths.js';
import { resolveInvocationRuntimeProviderFileWithOrigins } from '../../infra/config/runtime-provider/invocation.js';
import {
  resolveRuntimeProviderFileWithOrigins,
  RuntimeAssignmentSelectionError,
  type ResolvedRuntimeProviderFileWithOrigins,
} from '../../infra/config/runtime-provider/loader.js';

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
  const paths = {
    globalConfigDir: getGlobalConfigDir(),
    projectConfigDir: getProjectConfigDir(cwd),
  };
  let resolved: ResolvedRuntimeProviderFileWithOrigins;
  try {
    resolved = resolveInvocationRuntimeProviderFileWithOrigins(paths);
  } catch (error) {
    if (!(error instanceof RuntimeAssignmentSelectionError)) throw error;
    // The invocation's selection does not have to exist in this repository.
    // Enumerating the candidates only needs the defined names, so resolve
    // this repository's own runtime file without the invocation's selection.
    resolved = resolveRuntimeProviderFileWithOrigins(paths);
  }
  const defined = resolved.runtimeFile?.provider?.assignments ?? {};
  const runtimeAssignments: ManagerRuntimeAssignment[] = [];
  const missingRuntimeAssignments: string[] = [];
  for (const [name, usageDescription] of entries) {
    if (!Object.hasOwn(defined, name)) missingRuntimeAssignments.push(name);
    else runtimeAssignments.push({ name, ...(usageDescription === undefined ? {} : { usageDescription }) });
  }
  return { runtimeAssignments, missingRuntimeAssignments };
}
