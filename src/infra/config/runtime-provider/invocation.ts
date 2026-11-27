import { AsyncLocalStorage } from 'node:async_hooks';
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
let suppliedRuntime: ResolvedRuntimeProviderFileWithOrigins | undefined;

/** Only used in the isolated task process; all runtime lookups use this fixed input. */
export function setExecutionRuntimeProviderConfiguration(configuration: ResolvedRuntimeProviderFileWithOrigins): void {
  suppliedRuntime = structuredClone(configuration);
}

const taskRuntimeAssignments = new AsyncLocalStorage<string | undefined>();

/** action の実行中だけ、タスクの runtime assignment を設定する。undefined なら何も設定しない。 */
export function withTaskRuntimeAssignment<T>(runtimeAssignment: string | undefined, action: () => T): T {
  return runtimeAssignment === undefined ? action() : taskRuntimeAssignments.run(runtimeAssignment, action);
}

/** 保存時は、割り当て未指定の場合も保存対象のタスクのスコープに切り替える。 */
export function withTaskSaveRuntimeAssignment<T>(runtimeAssignment: string | undefined, action: () => T): T {
  return taskRuntimeAssignments.run(runtimeAssignment, action);
}

/** CLI の指定とは独立に、保存する割り当てを実際に選択できることを確認する。 */
export function validateTaskRuntimeAssignmentForSave(projectCwd: string, runtimeAssignment: string | undefined): void {
  if (runtimeAssignment === undefined) return;
  resolveRuntimeProviderFileWithOrigins({
    globalConfigDir: getGlobalConfigDir(),
    projectConfigDir: getProjectConfigDir(projectCwd),
    ...invocationOptions(runtimeAssignment, invocation?.runtimeFilePath, projectCwd),
  });
}

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
  return invocation?.runtimeAssignment ?? taskRuntimeAssignments.getStore();
}

/** `--runtime-assignment` で起動時に指定された assignment。タスクごとの値は含まない。 */
export function getInvocationRuntimeAssignmentOverride(): string | undefined {
  return invocation?.runtimeAssignment;
}

export function getInvocationRuntimeFilePath(): string | undefined {
  return invocation?.runtimeFilePath;
}

export function resolveInvocationRuntimeProviderFileWithOrigins(
  paths: RuntimeProviderPaths,
): ResolvedRuntimeProviderFileWithOrigins {
  if (suppliedRuntime !== undefined) return structuredClone(suppliedRuntime);
  const taskRuntimeAssignment = invocation?.runtimeAssignment === undefined
    ? taskRuntimeAssignments.getStore()
    : undefined;
  if (invocation === undefined) {
    return resolveRuntimeProviderFileWithOrigins({
      ...paths,
      ...(taskRuntimeAssignment === undefined ? {} : { runtimeAssignment: taskRuntimeAssignment }),
    });
  }
  const key = runtimePathsKey(paths, taskRuntimeAssignment);
  let resolved = invocation.resolvedFiles.get(key);
  if (resolved === undefined) {
    resolved = resolveRuntimeProviderFileWithOrigins({
      ...paths,
      ...invocationOptions(
        invocation.runtimeAssignment ?? taskRuntimeAssignment,
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

function runtimePathsKey(paths: RuntimeProviderPaths, taskRuntimeAssignment?: string): string {
  return JSON.stringify([
    resolve(paths.globalConfigDir),
    resolve(paths.projectConfigDir),
    taskRuntimeAssignment ?? null,
  ]);
}
