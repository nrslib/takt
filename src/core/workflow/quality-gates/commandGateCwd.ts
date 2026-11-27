import { resolve } from 'node:path';

export function resolveGateCwd(projectRoot: string, cwd: string | undefined): string {
  return cwd ? resolve(projectRoot, cwd) : projectRoot;
}
