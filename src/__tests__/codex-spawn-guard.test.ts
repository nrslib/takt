import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn as esmSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../infra/codex/codex-spawn-guard.js';

type SpawnFunction = (
  command: string,
  argsOrOptions?: readonly string[] | SpawnOptions,
  options?: SpawnOptions,
) => ChildProcess;

type FakeExecutableMode = 'exit' | 'epipe' | 'hang';

const require = createRequire(import.meta.url);
const childProcessModule = require('node:child_process') as { spawn: SpawnFunction };
const tempRoots = new Set<string>();

function makeFakeExecutable(name: string, mode: FakeExecutableMode = 'exit'): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-codex-guard-'));
  tempRoots.add(dir);
  const fileName = process.platform === 'win32' ? `${name}.cmd` : name;
  const file = join(dir, fileName);
  if (process.platform === 'win32') {
    writeFileSync(file, '@echo off\r\nexit /b 0\r\n');
  } else {
    const script = mode === 'exit'
      ? '#!/bin/sh\nexit 0\n'
      : mode === 'epipe'
        ? '#!/bin/sh\nexec 0<&-\nsleep 0.2\nexit 42\n'
        : '#!/bin/sh\nexec 0<&-\nwhile :; do :; done\n';
    writeFileSync(file, script);
    chmodSync(file, 0o755);
  }
  return file;
}

function cleanupTempRoots(): void {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
}

function spawnOptions(): SpawnOptions {
  return {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(process.platform === 'win32' ? { shell: true } : {}),
  };
}

function waitForClose(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function runCodex(executablePath: string): Promise<void> {
  const { Codex } = await import('@openai/codex-sdk');
  const thread = new Codex({ codexPathOverride: executablePath }).startThread();
  const streamed = await thread.runStreamed('x'.repeat(1024 * 1024));
  for await (const _event of streamed.events) {
    void _event;
  }
}

describe('codex-spawn-guard', () => {
  afterEach(() => {
    cleanupTempRoots();
  });

  it('synchronizes the CJS patch into ESM child_process bindings', () => {
    expect(childProcessModule.spawn).toBe(esmSpawn);
  });

  it('attaches and removes stdio listeners independently for parallel Codex spawns', async () => {
    const children = [
      childProcessModule.spawn(makeFakeExecutable('codex'), [], spawnOptions()),
      childProcessModule.spawn(makeFakeExecutable('codex'), [], spawnOptions()),
    ];

    for (const child of children) {
      expect(child.stdin).not.toBeNull();
      expect((child.stdin as EventEmitter).listenerCount('error')).toBeGreaterThan(0);
      expect((child.stdout as EventEmitter).listenerCount('error')).toBeGreaterThan(0);
      expect((child.stderr as EventEmitter).listenerCount('error')).toBeGreaterThan(0);
      expect((child as EventEmitter).listenerCount('error')).toBeGreaterThan(0);
    }

    await Promise.all(children.map(waitForClose));
    for (const child of children) {
      expect((child.stdin as EventEmitter).listenerCount('error')).toBe(0);
      expect((child.stdout as EventEmitter).listenerCount('error')).toBe(0);
      expect((child.stderr as EventEmitter).listenerCount('error')).toBe(0);
      expect((child as EventEmitter).listenerCount('error')).toBe(0);
    }
  });

  it('does not alter non-Codex spawns or the spawn(command, options) overload', async () => {
    const environment = { ...process.env };
    delete environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
    const child = childProcessModule.spawn(
      makeFakeExecutable('other'),
      ['exec', '--experimental-json'],
      { ...spawnOptions(), env: environment },
    );
    const overloadChild = childProcessModule.spawn(makeFakeExecutable('other-overload'), spawnOptions());

    for (const spawnedChild of [child, overloadChild]) {
      expect(spawnedChild.stdin).not.toBeNull();
      expect((spawnedChild.stdin as EventEmitter).listenerCount('error')).toBe(0);
      expect((spawnedChild.stdout as EventEmitter).listenerCount('error')).toBe(0);
      expect((spawnedChild.stderr as EventEmitter).listenerCount('error')).toBe(0);
    }

    await Promise.all([waitForClose(child), waitForClose(overloadChild)]);
  });

  it.skipIf(process.platform === 'win32')('handles a real EPIPE and terminates a stuck Codex child', async () => {
    const child = childProcessModule.spawn(makeFakeExecutable('codex', 'hang'), [], spawnOptions());
    const stdin = child.stdin;
    expect(stdin).not.toBeNull();
    if (!stdin) {
      throw new Error('Codex fixture must have a stdin pipe');
    }

    const epipe = new Promise<Error>((resolve) => {
      stdin.once('error', resolve);
    });
    stdin.write('x'.repeat(1024 * 1024));
    stdin.end();

    await expect(epipe).resolves.toMatchObject({ code: 'EPIPE' });
    const result = await waitForClose(child);

    expect(result.signal).toBe('SIGTERM');
    expect(stdin.listenerCount('error')).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('protects the actual SDK ESM spawn binding for a renamed Codex executable', async () => {
    const codexPath = makeFakeExecutable('renamed-codex', 'epipe');

    await expect(runCodex(codexPath)).rejects.toThrow(/Codex Exec exited with/);
  });
});
