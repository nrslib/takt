import { basename, isAbsolute } from 'node:path';

export function resolveNpmInvocation(nodeExecutable, npmExecPath) {
  if (!isAbsolute(nodeExecutable)) {
    throw new Error(`Node executable must be absolute: ${nodeExecutable}`);
  }
  if (typeof npmExecPath !== 'string' || !isAbsolute(npmExecPath)) {
    throw new Error('npm_execpath must be an absolute path');
  }
  if (basename(npmExecPath).toLowerCase() !== 'npm-cli.js') {
    throw new Error(`npm_execpath must identify npm-cli.js: ${npmExecPath}`);
  }
  return {
    executable: nodeExecutable,
    args: [npmExecPath],
  };
}
