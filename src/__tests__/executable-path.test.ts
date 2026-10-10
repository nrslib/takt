import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSystem32ExecutablePath, resolveWindowsPowerShellExecutablePath } from '../shared/utils/executable-path.js';

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

describe('Windows PowerShell executable path resolution', () => {
  let root: string;
  let system32: string;
  let powershellDirectory: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-powershell-path-'));
    temporaryDirectories.push(root);
    system32 = join(root, 'System32');
    powershellDirectory = join(system32, 'WindowsPowerShell', 'v1.0');
    mkdirSync(powershellDirectory, { recursive: true });
    process.env.SystemRoot = root;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  });

  it('should resolve the OS executable even when a project executable also exists', () => {
    const project = join(root, 'repo');
    mkdirSync(project);
    createExecutable(project, 'powershell.exe');
    const powershell = createExecutable(powershellDirectory, 'powershell.exe');

    expect(resolveWindowsPowerShellExecutablePath()).toBe(realpathSync(powershell));
  });

  it.each([undefined, '', ' ', 'Windows'])('should reject SystemRoot %j', (systemRoot) => {
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;

    expect(() => resolveWindowsPowerShellExecutablePath()).toThrow();
  });

  it('should reject a missing executable even when another powershell.exe exists', () => {
    createExecutable(root, 'powershell.exe');

    expect(() => resolveWindowsPowerShellExecutablePath()).toThrow();
  });

  it('should reject a directory named powershell.exe', () => {
    mkdirSync(join(powershellDirectory, 'powershell.exe'));

    expect(() => resolveWindowsPowerShellExecutablePath()).toThrow();
  });

  it('should reject a PowerShell directory resolving outside System32', () => {
    const outside = join(root, 'System32-other');
    mkdirSync(outside);
    createExecutable(outside, 'powershell.exe');
    rmSync(powershellDirectory, { recursive: true });
    symlinkSync(outside, powershellDirectory, 'junction');

    expect(() => resolveWindowsPowerShellExecutablePath()).toThrow();
  });

  it('should reject a System32 directory resolving outside the OS root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'takt-project-path-'));
    temporaryDirectories.push(outside);
    const outsidePowerShell = join(outside, 'WindowsPowerShell', 'v1.0');
    mkdirSync(outsidePowerShell, { recursive: true });
    createExecutable(outsidePowerShell, 'powershell.exe');
    rmSync(system32, { recursive: true });
    symlinkSync(outside, system32, 'junction');

    expect(() => resolveWindowsPowerShellExecutablePath()).toThrow();
  });

  it('should preserve System32 taskkill resolution and reject nested commands', () => {
    const taskkill = createExecutable(system32, 'taskkill.exe');

    expect(resolveSystem32ExecutablePath('taskkill.exe')).toBe(realpathSync(taskkill));
    expect(() => resolveSystem32ExecutablePath('WindowsPowerShell/v1.0/powershell.exe')).toThrow();
    expect(() => resolveSystem32ExecutablePath('WindowsPowerShell\\v1.0\\powershell.exe')).toThrow();
  });

  it('should reject unavailable taskkill instead of using a project executable', () => {
    createExecutable(root, 'taskkill.exe');

    expect(() => resolveSystem32ExecutablePath('taskkill.exe')).toThrow();
  });
});
