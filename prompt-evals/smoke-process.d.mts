export function runSmokeScript(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { timeoutMs: number },
): Promise<{ stdout: string; stderr: string; exitCode: 0 }>;

export interface SmokeCaseResult {
  name: string;
  status: 'passed' | 'failed';
}

export interface SmokeBatchResult {
  status: 'passed' | 'failed';
  cases: SmokeCaseResult[];
}

export function runSmokeBatch(cases: Array<{
  name: string;
  run(): Promise<unknown>;
}>): Promise<SmokeBatchResult>;
