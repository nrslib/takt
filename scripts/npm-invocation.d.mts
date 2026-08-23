export interface NpmInvocation {
  readonly executable: string;
  readonly args: readonly string[];
}

export function resolveNpmInvocation(
  nodeExecutable: string,
  npmExecPath: string | undefined,
): NpmInvocation;
