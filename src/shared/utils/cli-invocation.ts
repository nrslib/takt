import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export function resolveCliInvocation(command: string): { cliPath: string; args: string[] } {
  const built = fileURLToPath(new URL('../../app/cli/index.js', import.meta.url));
  if (existsSync(built)) return { cliPath: built, args: [built, command] };
  const cliPath = fileURLToPath(new URL('../../app/cli/index.ts', import.meta.url));
  return {
    cliPath,
    args: ['--import', createRequire(import.meta.url).resolve('tsx/esm'), cliPath, command],
  };
}
