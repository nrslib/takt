import { basename, win32 } from 'node:path';

export function workspaceName(input) {
  return input.includes('\\') ? win32.basename(input) : basename(input);
}
