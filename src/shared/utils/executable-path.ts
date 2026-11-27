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

function resolveSystem32Directory(command: string): string {
  const systemRoot = readEnvironmentValue('SystemRoot');
  if (systemRoot === undefined || systemRoot.trim() === '') {
    throw new Error(`Unable to resolve ${command} because SystemRoot is not configured`);
  }
  if (!isAbsolute(systemRoot)) {
    throw new Error(`Unable to resolve ${command} because SystemRoot is not absolute`);
  }
  const canonicalRoot = realpathSync(systemRoot);
  const system32 = realpathSync(join(canonicalRoot, 'System32'));
  if (!isWithinDirectory(canonicalRoot, system32)) {
    throw new Error(`System32 resolves outside SystemRoot: ${system32}`);
  }
  return system32;
}

function resolveExecutableWithinDirectory(directory: string, candidate: string): string {
  if (!isExecutableFile(candidate)) {
    throw new Error(`Unable to resolve System32 executable: ${candidate}`);
  }
  const canonicalCandidate = realpathSync(candidate);
  if (!isWithinDirectory(directory, canonicalCandidate)) {
    throw new Error(`System32 executable resolves outside System32: ${candidate}`);
  }
  return canonicalCandidate;
}

export function resolveSystem32ExecutablePath(command: string): string {
  if (process.platform !== 'win32') {
    throw new Error(`${command} is only available on Windows`);
  }
  if (command === '' || command !== command.replaceAll('/', '').replaceAll('\\', '')) {
    throw new Error(`System32 executable name must be a bare command: ${command}`);
  }
  const system32 = resolveSystem32Directory(command);
  return resolveExecutableWithinDirectory(system32, join(system32, command));
}

export function resolveWindowsPowerShellExecutablePath(): string {
  if (process.platform !== 'win32') {
    throw new Error('powershell.exe is only available on Windows');
  }
  const system32 = resolveSystem32Directory('powershell.exe');
  const candidate = join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return resolveExecutableWithinDirectory(system32, candidate);
}
