import { resolve } from 'node:path';
import { getGlobalConfigDir, getProjectConfigDir } from '../paths.js';
import {
  resolveRuntimeProviderFileWithOrigins,
  type ResolveRuntimeProviderInput,
  type ResolvedRuntimeProviderFileWithOrigins,
} from './loader.js';

type RuntimeProviderPaths = Pick<ResolveRuntimeProviderInput, 'globalConfigDir' | 'projectConfigDir'>;

interface RuntimeProviderInvocation {
  readonly runtimeAssignment?: string;
  readonly runtimeFilePath?: string;
  readonly resolvedFiles: Map<string, ResolvedRuntimeProviderFileWithOrigins>;
}

let invocation: RuntimeProviderInvocation | undefined;

export function prepareRuntimeAssignmentInvocation(
  projectCwd: string,
  runtimeAssignment: string | undefined,
  runtimeFilePath?: string,
): void {
  invocation = undefined;
  if (runtimeAssignment === undefined && runtimeFilePath === undefined) {
    return;
  }
  resolveRuntimeProviderFileWithOrigins({
    globalConfigDir: getGlobalConfigDir(),
    projectConfigDir: getProjectConfigDir(projectCwd),
    ...invocationOptions(runtimeAssignment, runtimeFilePath, projectCwd),
  });
}

export function initializeRuntimeAssignmentInvocation(
  projectCwd: string,
  runtimeAssignment: string | undefined,
  runtimeFilePath?: string,
): void {
  invocation = undefined;
  if (runtimeAssignment === undefined && runtimeFilePath === undefined) {
    return;
  }
  const paths = {
    globalConfigDir: getGlobalConfigDir(),
    projectConfigDir: getProjectConfigDir(projectCwd),
  };
  const options = invocationOptions(runtimeAssignment, runtimeFilePath, projectCwd);
  const resolved = resolveRuntimeProviderFileWithOrigins({ ...paths, ...options });
  invocation = {
    ...options,
    resolvedFiles: new Map([[runtimePathsKey(paths), resolved]]),
  };
}

export function getInvocationRuntimeAssignment(): string | undefined {
  return invocation?.runtimeAssignment;
}

export function getInvocationRuntimeFilePath(): string | undefined {
  return invocation?.runtimeFilePath;
}

export function resolveInvocationRuntimeProviderFileWithOrigins(
  paths: RuntimeProviderPaths,
): ResolvedRuntimeProviderFileWithOrigins {
  if (invocation === undefined) {
    return resolveRuntimeProviderFileWithOrigins(paths);
  }
  const key = runtimePathsKey(paths);
  let resolved = invocation.resolvedFiles.get(key);
  if (resolved === undefined) {
    resolved = resolveRuntimeProviderFileWithOrigins({
      ...paths,
      ...invocationOptions(
        invocation.runtimeAssignment,
        invocation.runtimeFilePath,
        paths.projectConfigDir,
      ),
    });
    invocation.resolvedFiles.set(key, resolved);
  }
  // Consumer の変更が同じ起動の別 resolver へ漏れないようにする。
  return structuredClone(resolved);
}

function invocationOptions(
  runtimeAssignment: string | undefined,
  runtimeFilePath: string | undefined,
  projectCwd: string,
): Pick<ResolveRuntimeProviderInput, 'runtimeAssignment' | 'runtimeFilePath'> {
  return {
    ...(runtimeAssignment === undefined ? {} : { runtimeAssignment }),
    ...(runtimeFilePath === undefined ? {} : { runtimeFilePath: resolve(projectCwd, runtimeFilePath) }),
  };
}

function runtimePathsKey(paths: RuntimeProviderPaths): string {
  return JSON.stringify([resolve(paths.globalConfigDir), resolve(paths.projectConfigDir)]);
}
