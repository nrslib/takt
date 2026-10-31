import { execFileSync } from 'node:child_process';

export function suppressMergeDrivers(cwd: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let names: string[];
  try {
    names = execFileSync('git', ['config', '--null', '--name-only', '--get-regexp', '^merge\\..*\\.driver$'], {
      cwd, env: environment, encoding: 'utf8', stdio: 'pipe',
    }).split('\0').filter(Boolean);
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 1) return environment;
    throw error;
  }
  if (names.length === 0) return environment;
  const env = { ...environment };
  let count = Number(env.GIT_CONFIG_COUNT ?? 0);
  for (const name of new Set(names)) {
    env[`GIT_CONFIG_KEY_${count}`] = name;
    env[`GIT_CONFIG_VALUE_${count}`] = 'false';
    count += 1;
  }
  env.GIT_CONFIG_COUNT = String(count);
  return env;
}
