import { homedir } from 'node:os';
import { join } from 'node:path';

export function expandHomePath(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function expandOptionalHomePath(path: string | undefined): string | undefined {
  return path === undefined ? undefined : expandHomePath(path);
}
