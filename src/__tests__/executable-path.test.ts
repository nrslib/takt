import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSystem32ExecutablePath } from '../shared/utils/executable-path.js';

const temporaryDirectories: string[] = [];
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
let originalSystemRoot: string | undefined;

function createExecutable(directory: string, name: string): string {
  const path = join(directory, name);
  writeFileSync(path, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  originalSystemRoot = process.env.SystemRoot;
});

afterEach(() => {
  if (originalPlatform !== undefined) {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
  if (originalSystemRoot === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = originalSystemRoot;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('System32 executable path resolution', () => {
  it('should fail when Windows SystemRoot is missing instead of searching PATH', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    delete process.env.SystemRoot;

    expect(() => resolveSystem32ExecutablePath('taskkill.exe'))
      .toThrow('SystemRoot is not configured');
  });

  it.runIf(process.platform !== 'win32')(
    'should resolve only the requested executable under System32',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'takt-system32-path-'));
      temporaryDirectories.push(root);
      const system32 = join(root, 'System32');
      mkdirSync(system32);
      const taskkill = createExecutable(system32, 'taskkill.exe');
      process.env.SystemRoot = root;
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });

      expect(resolveSystem32ExecutablePath('taskkill.exe')).toBe(realpathSync(taskkill));
    },
  );
});
