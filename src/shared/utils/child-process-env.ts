/**
 * Process environment boundary for nested tools. Central Web UI workers need
 * the global config in their host process, but provider/quality-gate/MCP
 * children must never inherit the central ownership namespace.
 */
const CENTRAL_ENV_PREFIX = 'TAKT_CENTRAL_';
let centralExecutionDepth = 0;

function normalizedEnvironmentKey(key: string): string {
  return process.platform === 'win32' ? key.toUpperCase() : key;
}

export function enterCentralExecution(): () => void {
  centralExecutionDepth += 1;
  return () => {
    centralExecutionDepth = Math.max(0, centralExecutionDepth - 1);
  };
}

export function isCentralExecution(): boolean {
  return centralExecutionDepth > 0;
}

export function buildChildProcessEnv(
  source: NodeJS.ProcessEnv = process.env,
  options: { readonly centralExecution?: boolean } = {},
): NodeJS.ProcessEnv {
  const env = { ...source };
  if (options.centralExecution === true || isCentralExecution()) {
    for (const key of Object.keys(env)) {
      const normalizedKey = normalizedEnvironmentKey(key);
      if (normalizedKey === 'TAKT_CONFIG_DIR' || normalizedKey.startsWith(CENTRAL_ENV_PREFIX)) {
        delete env[key];
      }
    }
  }
  return env;
}
