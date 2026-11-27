import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

function isWithin(directory: string, candidate: string): boolean {
  const path = relative(directory, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function system32Directory(command: string): Promise<string> {
  if (process.platform !== 'win32') throw new Error(`${command} is only available on Windows`);
  const root = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
  if (root === undefined || root.trim() === '' || !isAbsolute(root)) throw new Error('SystemRoot must be configured and absolute');
  const canonical = await realpath(root);
  const system32 = await realpath(join(canonical, 'System32'));
  if (!isWithin(canonical, system32)) throw new Error('System32 resolves outside SystemRoot');
  return system32;
}

async function executable(directory: string, candidate: string): Promise<string> {
  const canonical = await realpath(candidate);
  if (!isWithin(directory, canonical) || !(await stat(canonical)).isFile()) throw new Error('Invalid System32 executable');
  if (process.platform !== 'win32') await access(canonical, constants.X_OK);
  return canonical;
}

export async function resolveSystem32ExecutablePathAsync(command: string): Promise<string> {
  if (command === '' || /[/\\]/.test(command)) throw new Error('System32 executable name must be a bare command');
  const directory = await system32Directory(command);
  return executable(directory, join(directory, command));
}

export async function resolveWindowsPowerShellExecutablePathAsync(): Promise<string> {
  const directory = await system32Directory('powershell.exe');
  return executable(directory, join(directory, 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
}
