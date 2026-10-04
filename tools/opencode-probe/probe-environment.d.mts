export function prepareIsolatedProbeEnvironment(
  source: NodeJS.ProcessEnv,
  runtimeRoot: string,
): NodeJS.ProcessEnv;

export function markProbeWorkerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

export function isProbeWorkerEnvironment(source: NodeJS.ProcessEnv): boolean;
