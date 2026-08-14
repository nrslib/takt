export type ProbePhase = 'ready' | 'cleanupStart' | 'failureCleanupStart';
export type ObservedProbePhase = 'startup' | 'execution' | 'cleanup' | 'failure-cleanup';

export function parseProbeResult(stdout: string): unknown;

export function reportProbePhase(phase: ProbePhase): void;

export function runProbeProcess(
  script: string,
  args: readonly string[],
  options: {
    startupTimeout: number;
    executionTimeout: number;
    cleanupTimeout: number;
    env: NodeJS.ProcessEnv;
  },
): Promise<{ stdout: string; stderr: string }>;
