import {
  accessSync,
  constants,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

function readEnvironmentValue(name: string): string | undefined {
  const entry = Object.entries(process.env)
    .find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const pathFromDirectory = relative(directory, candidate);
  return pathFromDirectory === ''
    || (!pathFromDirectory.startsWith(`..${sep}`)
      && pathFromDirectory !== '..'
      && !isAbsolute(pathFromDirectory));
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    if (process.platform !== 'win32') {
      accessSync(path, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export function resolveSystem32ExecutablePath(command: string): string {
  if (process.platform !== 'win32') {
    throw new Error(`${command} is only available on Windows`);
  }
  if (command === '' || command !== command.replaceAll('/', '').replaceAll('\\', '')) {
    throw new Error(`System32 executable name must be a bare command: ${command}`);
  }
  const systemRoot = readEnvironmentValue('SystemRoot');
  if (systemRoot === undefined || systemRoot.trim() === '') {
    throw new Error(`Unable to resolve ${command} because SystemRoot is not configured`);
  }
  const system32 = realpathSync(join(systemRoot, 'System32'));
  const candidate = join(system32, command);
  if (!isExecutableFile(candidate)) {
    throw new Error(`Unable to resolve System32 executable: ${candidate}`);
  }
  const canonicalCandidate = realpathSync(candidate);
  if (!isWithinDirectory(system32, canonicalCandidate)) {
    throw new Error(`System32 executable resolves outside System32: ${candidate}`);
  }
  return canonicalCandidate;
}
