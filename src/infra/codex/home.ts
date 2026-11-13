import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

type CodexEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveHomeDirectory(environment: CodexEnvironment): string {
  const configuredHome = environment.HOME || environment.USERPROFILE;
  if (configuredHome) {
    return resolve(configuredHome);
  }
  return homedir();
}

export function resolveCodexHomeDirectory(environment: CodexEnvironment): string {
  return resolve(environment.CODEX_HOME || join(resolveHomeDirectory(environment), '.codex'));
}
