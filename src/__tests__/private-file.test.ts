import {
  chmodSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const TEST_TMPDIR = realpathSync(tmpdir());

const injectedFileFailure = vi.hoisted(() => ({
  operation: '' as '' | 'open' | 'fstat' | 'fchmod' | 'ftruncate' | 'read' | 'write' | 'partialWrite' | 'append' | 'close' | 'rename',
  cleanupOperation: '' as '' | 'unlink',
  skipMatchingCalls: 0,
  descriptor: undefined as number | undefined,
  descriptorPaths: new Map<number, string>(),
  pathPredicate: undefined as ((path: string) => boolean) | undefined,
  skipBeforeOpenCalls: 0,
  beforeOpen: undefined as (() => void) | undefined,
  beforeArtifactCreation: undefined as (() => void) | undefined,
  beforePublication: undefined as (() => void) | undefined,
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawnSync(...args: Parameters<typeof actual.spawnSync>) {
      const commandArguments = args[1];
      const isPublication = Array.isArray(commandArguments)
        && commandArguments.some((argument) => argument.includes('"operation":"publish"'));
      if (isPublication) {
        const beforePublication = injectedFileFailure.beforePublication;
        injectedFileFailure.beforePublication = undefined;
        beforePublication?.();
        if (injectedFileFailure.operation === 'rename') {
          const rawRequest = commandArguments[2];
          if (rawRequest === undefined) {
            throw new Error('Publication request is missing');
          }
          const request: unknown = JSON.parse(rawRequest);
          if (
            request === null
            || typeof request !== 'object'
            || typeof (request as Record<string, unknown>).temporaryName !== 'string'
          ) {
            throw new Error('Publication request is invalid');
          }
          const options = args[2];
          if (typeof options !== 'object' || options === null || typeof options.cwd !== 'string') {
            throw new Error('Publication cwd is missing');
          }
          const temporaryPath = join(options.cwd, (request as { temporaryName: string }).temporaryName);
          if (
            injectedFileFailure.pathPredicate === undefined
            || injectedFileFailure.pathPredicate(temporaryPath)
          ) {
            injectedFileFailure.operation = '';
            throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
          }
        }
      } else {
        const beforeArtifactCreation = injectedFileFailure.beforeArtifactCreation;
        injectedFileFailure.beforeArtifactCreation = undefined;
        beforeArtifactCreation?.();
      }
      return actual.spawnSync(...args);
    },
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const shouldFailDescriptor = (descriptor: number): boolean => {
    const path = injectedFileFailure.descriptorPaths.get(descriptor);
    return injectedFileFailure.pathPredicate === undefined
      || (path !== undefined && injectedFileFailure.pathPredicate(path));
  };
  return {
    ...actual,
    openSync(...args: Parameters<typeof actual.openSync>) {
      const path = String(args[0]);
      if (
        injectedFileFailure.operation === 'open'
        && (injectedFileFailure.pathPredicate === undefined || injectedFileFailure.pathPredicate(path))
      ) {
        if (injectedFileFailure.skipMatchingCalls > 0) {
          injectedFileFailure.skipMatchingCalls -= 1;
        } else {
          injectedFileFailure.operation = '';
          throw Object.assign(new Error('injected open failure'), { code: 'EIO' });
        }
      }
      if (injectedFileFailure.skipBeforeOpenCalls > 0) {
        injectedFileFailure.skipBeforeOpenCalls -= 1;
        const descriptor = actual.openSync(...args);
        injectedFileFailure.descriptorPaths.set(descriptor, String(args[0]));
        return descriptor;
      }
      const beforeOpen = injectedFileFailure.beforeOpen;
      injectedFileFailure.beforeOpen = undefined;
      beforeOpen?.();
      const descriptor = actual.openSync(...args);
      injectedFileFailure.descriptorPaths.set(descriptor, String(args[0]));
      return descriptor;
    },
    closeSync(...args: Parameters<typeof actual.closeSync>) {
      const shouldFail = injectedFileFailure.operation === 'close' && shouldFailDescriptor(args[0]);
      try {
        return actual.closeSync(...args);
      } finally {
        injectedFileFailure.descriptorPaths.delete(args[0]);
        if (shouldFail) {
          injectedFileFailure.operation = '';
          injectedFileFailure.descriptor = args[0];
          throw Object.assign(new Error('injected close failure'), { code: 'EIO' });
        }
      }
    },
    fstatSync(...args: Parameters<typeof actual.fstatSync>) {
      if (injectedFileFailure.operation === 'fstat' && shouldFailDescriptor(args[0])) {
        if (injectedFileFailure.skipMatchingCalls > 0) {
          injectedFileFailure.skipMatchingCalls -= 1;
          return actual.fstatSync(...args);
        }
        injectedFileFailure.operation = '';
        injectedFileFailure.descriptor = args[0];
        throw Object.assign(new Error('injected fstat failure'), { code: 'EIO' });
      }
      return actual.fstatSync(...args);
    },
    fchmodSync(...args: Parameters<typeof actual.fchmodSync>) {
      if (injectedFileFailure.operation === 'fchmod' && shouldFailDescriptor(args[0])) {
        if (injectedFileFailure.skipMatchingCalls > 0) {
          injectedFileFailure.skipMatchingCalls -= 1;
          return actual.fchmodSync(...args);
        }
        injectedFileFailure.operation = '';
        injectedFileFailure.descriptor = args[0];
        throw Object.assign(new Error('injected fchmod failure'), { code: 'EPERM' });
      }
      return actual.fchmodSync(...args);
    },
    ftruncateSync(...args: Parameters<typeof actual.ftruncateSync>) {
      if (injectedFileFailure.operation === 'ftruncate') {
        injectedFileFailure.operation = '';
        injectedFileFailure.descriptor = args[0];
        throw Object.assign(new Error('injected ftruncate failure'), { code: 'EIO' });
      }
      return actual.ftruncateSync(...args);
    },
    readFileSync(...args: Parameters<typeof actual.readFileSync>) {
      if (injectedFileFailure.operation === 'read' && typeof args[0] === 'number') {
        injectedFileFailure.operation = '';
        injectedFileFailure.descriptor = args[0];
        throw Object.assign(new Error('injected read failure'), { code: 'EIO' });
      }
      return actual.readFileSync(...args);
    },
    writeFileSync(...args: Parameters<typeof actual.writeFileSync>) {
      if (
        (injectedFileFailure.operation === 'write' || injectedFileFailure.operation === 'partialWrite')
        && typeof args[0] === 'number'
        && shouldFailDescriptor(args[0])
      ) {
        const operation = injectedFileFailure.operation;
        injectedFileFailure.operation = '';
        injectedFileFailure.descriptor = args[0];
        if (operation === 'partialWrite') {
          const data = args[1];
          const partialData = typeof data === 'string'
            ? data.slice(0, Math.max(1, Math.floor(data.length / 2)))
            : data;
          actual.writeFileSync(args[0], partialData, args[2]);
        }
        throw Object.assign(new Error(`injected ${operation === 'partialWrite' ? 'partial write' : 'write'} failure`), {
          code: 'EIO',
        });
      }
      return actual.writeFileSync(...args);
    },
    appendFileSync(...args: Parameters<typeof actual.appendFileSync>) {
      if (injectedFileFailure.operation === 'append' && typeof args[0] === 'number') {
        injectedFileFailure.operation = '';
        injectedFileFailure.descriptor = args[0];
        throw Object.assign(new Error('injected append failure'), { code: 'EIO' });
      }
      return actual.appendFileSync(...args);
    },
    renameSync(...args: Parameters<typeof actual.renameSync>) {
      if (
        injectedFileFailure.operation === 'rename'
        && (injectedFileFailure.pathPredicate === undefined
          || injectedFileFailure.pathPredicate(String(args[0])))
      ) {
        injectedFileFailure.operation = '';
        throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      }
      return actual.renameSync(...args);
    },
    unlinkSync(...args: Parameters<typeof actual.unlinkSync>) {
      if (
        injectedFileFailure.cleanupOperation === 'unlink'
        && (injectedFileFailure.pathPredicate === undefined
          || injectedFileFailure.pathPredicate(String(args[0])))
      ) {
        injectedFileFailure.cleanupOperation = '';
        throw Object.assign(new Error('injected unlink failure'), { code: 'EIO' });
      }
      return actual.unlinkSync(...args);
    },
  };
});
import {
  appendPrivateFile,
  ensurePrivateDirectory,
  readRegularFileNoFollow,
  repairPrivateDirectory,
  writeNewPrivateFileWithMode,
  writePrivateFile,
  writePrivateFileWithMode,
  writePrivateFileWithModeGuarded,
} from '../shared/utils/private-file.js';

function isSiblingTemporaryFile(path: string, finalPath: string): boolean {
  return path !== finalPath && dirname(path) === dirname(finalPath);
}

// Windows には POSIX のモード・ディレクトリ記述子・rename 原子性の対応物が
// ない。これらの保証は POSIX ランナー（linux / macOS の CI ジョブ）で検証し、
// Windows ジョブではクロスプラットフォームな挙動（backend 経由の読み書き・
// symlink / swap の拒否・内容の保全）だけを検証する。
const itPosix = process.platform === 'win32' ? it.skip : it;

function expectPosixMode(actualMode: number, expectedMode: number): void {
  if (process.platform !== 'win32') {
    expect(actualMode & 0o777).toBe(expectedMode);
  }
}

describe('private file artifacts', () => {
  const roots: string[] = [];

  afterEach(() => {
    injectedFileFailure.operation = '';
    injectedFileFailure.cleanupOperation = '';
    injectedFileFailure.skipMatchingCalls = 0;
    injectedFileFailure.descriptor = undefined;
    injectedFileFailure.descriptorPaths.clear();
    injectedFileFailure.pathPredicate = undefined;
    injectedFileFailure.skipBeforeOpenCalls = 0;
    injectedFileFailure.beforeOpen = undefined;
    injectedFileFailure.beforeArtifactCreation = undefined;
    injectedFileFailure.beforePublication = undefined;
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should route the session-log storage pattern through the cross-platform backend on Windows', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-file-windows-backend-'));
    roots.push(root);
    const logs = join(root, '.takt', 'runs', 'run-1', 'logs');
    const file = join(logs, 'session.jsonl');

    try {
      ensurePrivateDirectory(logs);
      appendPrivateFile(file, '{"type":"workflow_start"}\n');
      expect(readFileSync(file, 'utf-8')).toBe('{"type":"workflow_start"}\n');
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    }
  });

  itPosix.each([
    ['temporary-file fstat', 'fstat'],
    ['temporary-file fchmod', 'fchmod'],
    ['partial temporary-file write', 'partialWrite'],
    ['temporary-file close', 'close'],
  ] as const)(
    'should preserve the existing artifact when %s fails',
    (_phase, operation) => {
      const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-file-failure-'));
      roots.push(root);
      const file = join(root, 'artifact.log');
      writeFileSync(file, 'original\n');
      chmodSync(file, 0o400);
      injectedFileFailure.operation = operation;
      injectedFileFailure.pathPredicate = (path) => isSiblingTemporaryFile(path, file);

      const expectedMessage = operation === 'partialWrite'
        ? 'injected partial write failure'
        : `injected ${operation} failure`;
      expect(() => writePrivateFile(file, 'replacement\n')).toThrow(expectedMessage);

      expect(readFileSync(file, 'utf-8')).toBe('original\n');
      expectPosixMode(statSync(file).mode, 0o400);
      expect(readdirSync(root)).toEqual(['artifact.log']);
    },
  );

  it('should discard the temporary file when a publication guard rejects the update', () => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-file-publication-guard-'));
    roots.push(root);
    const file = join(root, 'artifact.log');
    writeFileSync(file, 'original\n');
    chmodSync(file, 0o400);
    const publicationGuard = vi.fn().mockReturnValue(false);

    const published = writePrivateFileWithModeGuarded(
      file,
      'replacement\n',
      0o600,
      publicationGuard,
    );

    expect(published).toBe(false);
    expect(publicationGuard).toHaveBeenCalledOnce();
    expect(readFileSync(file, 'utf-8')).toBe('original\n');
    expectPosixMode(statSync(file).mode, 0o400);
    expect(readdirSync(root)).toEqual(['artifact.log']);
  });

  it.each([
    ['append preparation open', 'open', 0],
    ['append preparation fstat', 'fstat', 0],
    ['append preparation fchmod', 'fchmod', 0],
    ['append write-descriptor open', 'open', 1],
  ] as const)(
    'should preserve descriptor, content, and mode when %s fails',
    (_phase, operation, skippedCalls) => {
      const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-append-descriptor-failure-'));
      roots.push(root);
      const file = join(root, 'artifact.log');
      writeFileSync(file, 'original\n');
      chmodSync(file, 0o400);
      injectedFileFailure.operation = operation;
      injectedFileFailure.skipMatchingCalls = skippedCalls;
      injectedFileFailure.pathPredicate = (path) => path === file;

      expect(() => appendPrivateFile(file, 'appended\n')).toThrow(`injected ${operation} failure`);

      expect(readFileSync(file, 'utf-8')).toBe('original\n');
      expectPosixMode(statSync(file).mode, 0o400);
      if (injectedFileFailure.descriptor !== undefined) {
        expect(() => fstatSync(injectedFileFailure.descriptor!)).toThrow();
      }
    },
  );

  it.each(['open', 'fstat'] as const)(
    'should preserve the existing artifact when publication verification %s fails',
    (operation) => {
      const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-publication-verification-failure-'));
      roots.push(root);
      const file = join(root, 'artifact.log');
      writeFileSync(file, 'original\n');
      chmodSync(file, 0o400);
      injectedFileFailure.operation = operation;
      injectedFileFailure.pathPredicate = (path) => path === file;

      expect(() => writePrivateFile(file, 'replacement\n')).toThrow(`injected ${operation} failure`);

      expect(readFileSync(file, 'utf-8')).toBe('original\n');
      expectPosixMode(statSync(file).mode, 0o400);
      expect(readdirSync(root)).toEqual(['artifact.log']);
      if (injectedFileFailure.descriptor !== undefined) {
        expect(() => fstatSync(injectedFileFailure.descriptor!)).toThrow();
      }
    },
  );

  it.each([
    ['temporary-file fstat', 'fstat'],
    ['temporary-file fchmod', 'fchmod'],
    ['partial temporary-file write', 'partialWrite'],
    ['temporary-file close', 'close'],
  ] as const)('should close the descriptor when %s fails', (_phase, operation) => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-file-descriptor-failure-'));
    roots.push(root);
    const file = join(root, 'artifact.log');
    writeFileSync(file, 'original\n');
    injectedFileFailure.operation = operation;
    injectedFileFailure.pathPredicate = (path) => isSiblingTemporaryFile(path, file);

    const expectedMessage = operation === 'partialWrite'
      ? 'injected partial write failure'
      : `injected ${operation} failure`;
    expect(() => writePrivateFile(file, 'replacement\n')).toThrow(expectedMessage);

    expect(injectedFileFailure.descriptor).toBeDefined();
    expect(() => fstatSync(injectedFileFailure.descriptor!)).toThrow();
  });

  it('should leave no published artifact or temporary file when a new-file write fails', () => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-file-new-failure-'));
    roots.push(root);
    const file = join(root, 'artifact.log');
    injectedFileFailure.operation = 'partialWrite';
    injectedFileFailure.pathPredicate = (path) => dirname(path) === root;

    expect(() => writeNewPrivateFileWithMode(file, 'created content\n', 0o600))
      .toThrow('injected partial write failure');

    expect(existsSync(file)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it('should preserve the existing artifact and remove the temporary file when publication fails', () => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-file-publication-failure-'));
    roots.push(root);
    const file = join(root, 'artifact.log');
    writeFileSync(file, 'original\n');
    injectedFileFailure.operation = 'rename';
    injectedFileFailure.pathPredicate = (path) => isSiblingTemporaryFile(path, file);

    expect(() => writePrivateFile(file, 'replacement\n')).toThrow('injected rename failure');

    expect(readFileSync(file, 'utf-8')).toBe('original\n');
    expect(readdirSync(root)).toEqual(['artifact.log']);
  });

  itPosix('should never expose an empty or partial artifact to a concurrent reader', async () => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-file-atomic-reader-'));
    roots.push(root);
    const file = join(root, 'artifact.log');
    const stopFile = join(root, 'stop');
    const unexpectedFile = join(root, 'unexpected');
    const original = 'original\n';
    const replacement = `${'replacement-data-'.repeat(1024 * 1024)}\n`;
    writeFileSync(file, original);
    const reader = spawn(process.execPath, ['-e', [
      "const fs = require('node:fs')",
      'const [target, stop, unexpected, original, replacementLength] = process.argv.slice(1)',
      "process.stdout.write('READY\\n')",
      'while (!fs.existsSync(stop)) {',
      "  let content = ''",
      "  try { content = fs.readFileSync(target, 'utf8') } catch (error) {",
      "    if (error.code !== 'ENOENT') throw error",
      '  }',
      '  if (content !== original && content.length !== Number(replacementLength)) {',
      "    fs.writeFileSync(unexpected, String(content.length), 'utf8')",
      '    break',
      '  }',
      '}',
    ].join(';'), file, stopFile, unexpectedFile, original, String(replacement.length)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise<void>((resolveReady, rejectReady) => {
      reader.once('error', rejectReady);
      reader.stdout.once('data', () => resolveReady());
    });

    try {
      writePrivateFile(file, replacement);
    } finally {
      writeFileSync(stopFile, 'stop');
    }
    await new Promise<void>((resolveExit, rejectExit) => {
      reader.once('error', rejectExit);
      reader.once('exit', (code) => code === 0 ? resolveExit() : rejectExit(new Error(`reader exited ${String(code)}`)));
    });

    expect(existsSync(unexpectedFile)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(replacement);
  });

  it('should retain both the write and cleanup errors when both operations fail', () => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-file-combined-failure-'));
    roots.push(root);
    const file = join(root, 'artifact.log');
    writeFileSync(file, 'original\n');
    injectedFileFailure.operation = 'partialWrite';
    injectedFileFailure.cleanupOperation = 'unlink';
    injectedFileFailure.pathPredicate = (path) => isSiblingTemporaryFile(path, file);

    let thrown: unknown;
    try {
      writePrivateFile(file, 'replacement\n');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'injected partial write failure' }),
      expect.objectContaining({ message: 'injected unlink failure' }),
    ]);
    expect(readFileSync(file, 'utf-8')).toBe('original\n');
  });

  it.each([
    ['fstat', 'fstat'],
    ['fchmod', 'fchmod'],
  ] as const)('should close the directory descriptor when %s fails', (_phase, operation) => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-directory-failure-'));
    roots.push(root);
    const directory = join(root, 'reports');
    mkdirSync(directory);
    injectedFileFailure.operation = operation;

    expect(() => repairPrivateDirectory(directory)).toThrow(`injected ${operation} failure`);

    expect(injectedFileFailure.descriptor).toBeDefined();
    expect(() => fstatSync(injectedFileFailure.descriptor!)).toThrow();
  });

  it.each([
    ['fstat', 'fstat'],
    ['read', 'read'],
  ] as const)('should close the read descriptor when %s fails', (_phase, operation) => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-read-failure-'));
    roots.push(root);
    const file = join(root, 'source.ts');
    writeFileSync(file, 'original\n');
    const expectedStat = lstatSync(file);
    injectedFileFailure.operation = operation;

    expect(() => readRegularFileNoFollow(file, expectedStat)).toThrow(`injected ${operation} failure`);

    expect(readFileSync(file, 'utf-8')).toBe('original\n');
    expect(injectedFileFailure.descriptor).toBeDefined();
    expect(() => fstatSync(injectedFileFailure.descriptor!)).toThrow();
  });

  it.each([
    ['ftruncate', (path: string) => writePrivateFile(path, 'replacement\n')],
    ['write', (path: string) => writePrivateFile(path, 'replacement\n')],
    ['append', (path: string) => appendPrivateFile(path, 'appended\n')],
  ] as const)(
    'should close the write descriptor when %s fails',
    (operation, access) => {
      const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-file-write-failure-'));
      roots.push(root);
      const file = join(root, 'artifact.log');
      writeFileSync(file, 'original\n');
      injectedFileFailure.operation = operation;

      expect(() => access(file)).toThrow(`injected ${operation} failure`);

      expect(injectedFileFailure.descriptor).toBeDefined();
      expect(() => fstatSync(injectedFileFailure.descriptor!)).toThrow();
      expect(readFileSync(file, 'utf-8')).toBe('original\n');
    },
  );

  it('should reject a symlink swap after path inspection without changing either file', () => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-file-link-swap-'));
    roots.push(root);
    const file = join(root, 'artifact.log');
    const original = join(root, 'original.log');
    const outside = join(root, 'outside.log');
    writeFileSync(file, 'inside\n');
    writeFileSync(outside, 'outside\n');
    injectedFileFailure.beforeOpen = () => {
      renameSync(file, original);
      symlinkSync(outside, file);
    };

    expect(() => writePrivateFile(file, 'replacement\n')).toThrow();

    expect(readFileSync(original, 'utf-8')).toBe('inside\n');
    expect(readFileSync(outside, 'utf-8')).toBe('outside\n');
  });

  it('should reject a regular-file swap after path inspection without changing either file', () => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-file-regular-swap-'));
    roots.push(root);
    const file = join(root, 'artifact.log');
    const original = join(root, 'original.log');
    writeFileSync(file, 'inside\n');
    injectedFileFailure.beforeOpen = () => {
      renameSync(file, original);
      writeFileSync(file, 'substituted\n');
    };

    expect(() => writePrivateFile(file, 'replacement\n')).toThrow(/identity changed/);

    expect(readFileSync(original, 'utf-8')).toBe('inside\n');
    expect(readFileSync(file, 'utf-8')).toBe('substituted\n');
  });

  it('should reject a symlink swap immediately before publication without changing either file', () => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-file-publication-link-swap-'));
    roots.push(root);
    const file = join(root, 'artifact.log');
    const original = join(root, 'original.log');
    const outside = join(root, 'outside.log');
    writeFileSync(file, 'inside\n');
    writeFileSync(outside, 'outside\n');
    injectedFileFailure.beforePublication = () => {
      renameSync(file, original);
      symlinkSync(outside, file);
    };

    expect(() => writePrivateFile(file, 'replacement\n')).toThrow(/identity changed/);

    expect(readFileSync(original, 'utf-8')).toBe('inside\n');
    expect(readFileSync(outside, 'utf-8')).toBe('outside\n');
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
  });

  it('should reject a regular-file swap immediately before publication without changing either file', () => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-file-publication-regular-swap-'));
    roots.push(root);
    const file = join(root, 'artifact.log');
    const original = join(root, 'original.log');
    writeFileSync(file, 'inside\n');
    injectedFileFailure.beforePublication = () => {
      renameSync(file, original);
      writeFileSync(file, 'substituted\n');
    };

    expect(() => writePrivateFile(file, 'replacement\n')).toThrow(/identity changed/);

    expect(readFileSync(original, 'utf-8')).toBe('inside\n');
    expect(readFileSync(file, 'utf-8')).toBe('substituted\n');
  });

  it('should reject an ancestor swap immediately before publication without changing outside files', () => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-file-publication-ancestor-swap-'));
    roots.push(root);
    const logs = join(root, '.takt', 'runs', 'run-1', 'logs');
    const movedLogs = join(root, 'original-logs');
    const outsideLogs = join(root, 'outside-logs');
    mkdirSync(logs, { recursive: true });
    mkdirSync(outsideLogs);
    const file = join(logs, 'events.jsonl');
    const outsideFile = join(outsideLogs, 'events.jsonl');
    writeFileSync(file, 'inside\n');
    writeFileSync(outsideFile, 'outside\n');
    injectedFileFailure.beforePublication = () => {
      renameSync(logs, movedLogs);
      symlinkSync(outsideLogs, logs, 'dir');
    };

    expect(() => writePrivateFile(file, 'replacement\n')).toThrow(/identity changed/);

    expect(readFileSync(join(movedLogs, 'events.jsonl'), 'utf-8')).toBe('inside\n');
    expect(readFileSync(outsideFile, 'utf-8')).toBe('outside\n');
  });

  itPosix('should restore a read-only file mode when the file is swapped before the write descriptor opens', () => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-file-read-only-swap-'));
    roots.push(root);
    const file = join(root, 'artifact.log');
    const original = join(root, 'original.log');
    writeFileSync(file, 'inside\n');
    chmodSync(file, 0o400);
    injectedFileFailure.skipBeforeOpenCalls = 1;
    injectedFileFailure.beforeOpen = () => {
      renameSync(file, original);
      writeFileSync(file, 'substituted\n', { mode: 0o600 });
    };

    expect(() => writePrivateFile(file, 'replacement\n')).toThrow(/identity changed/);

    expect(readFileSync(original, 'utf-8')).toBe('inside\n');
    expect(statSync(original).mode & 0o777).toBe(0o400);
    expect(readFileSync(file, 'utf-8')).toBe('substituted\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('should reject an ancestor swap before opening without truncating the substituted file', () => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-file-swap-'));
    roots.push(root);
    const logs = join(root, '.takt', 'runs', 'run-1', 'logs');
    const movedLogs = join(root, 'original-logs');
    const outsideLogs = join(root, 'outside-logs');
    mkdirSync(logs, { recursive: true });
    mkdirSync(outsideLogs);
    const file = join(logs, 'events.jsonl');
    const outsideFile = join(outsideLogs, 'events.jsonl');
    writeFileSync(file, 'inside\n');
    writeFileSync(outsideFile, 'outside\n');
    injectedFileFailure.beforeOpen = () => {
      renameSync(logs, movedLogs);
      symlinkSync(outsideLogs, logs, 'dir');
    };

    expect(() => writePrivateFile(file, 'replacement\n')).toThrow(/identity changed/);

    expect(readFileSync(join(movedLogs, 'events.jsonl'), 'utf-8')).toBe('inside\n');
    expect(readFileSync(outsideFile, 'utf-8')).toBe('outside\n');
  });

  it('should validate the complete ancestor chain before truncating a matching hard link', () => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-file-ancestor-chain-'));
    roots.push(root);
    const runs = join(root, '.takt', 'runs');
    const logs = join(runs, 'run-1', 'logs');
    const movedRuns = join(root, 'original-runs');
    const outsideRuns = join(root, 'outside-runs');
    const outsideLogs = join(outsideRuns, 'run-1', 'logs');
    mkdirSync(logs, { recursive: true });
    mkdirSync(outsideLogs, { recursive: true });
    const file = join(logs, 'events.jsonl');
    const outsideFile = join(outsideLogs, 'events.jsonl');
    writeFileSync(file, 'inside\n');
    linkSync(file, outsideFile);
    injectedFileFailure.beforeOpen = () => {
      renameSync(runs, movedRuns);
      symlinkSync(outsideRuns, runs, 'dir');
    };

    expect(() => writePrivateFile(file, 'replacement\n')).toThrow(/identity changed/);

    expect(readFileSync(join(movedRuns, 'run-1', 'logs', 'events.jsonl'), 'utf-8')).toBe('inside\n');
    expect(readFileSync(outsideFile, 'utf-8')).toBe('inside\n');
  });

  it('should not create a file outside the trusted tree when its parent is swapped before creation', () => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-file-create-swap-'));
    roots.push(root);
    const logs = join(root, '.takt', 'runs', 'run-1', 'logs');
    const movedLogs = join(root, 'original-logs');
    const outsideLogs = join(root, 'outside-logs');
    mkdirSync(logs, { recursive: true });
    mkdirSync(outsideLogs);
    const file = join(logs, 'events.jsonl');
    injectedFileFailure.beforeArtifactCreation = () => {
      renameSync(logs, movedLogs);
      symlinkSync(outsideLogs, logs, 'dir');
    };

    expect(() => writePrivateFile(file, 'created\n')).toThrow(/parent directory identity changed/);

    expect(existsSync(join(outsideLogs, 'events.jsonl'))).toBe(false);
  });

  it('should not create a directory outside the trusted tree when its parent is swapped before creation', () => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-directory-create-swap-'));
    roots.push(root);
    const runs = join(root, '.takt', 'runs');
    const movedRuns = join(root, 'original-runs');
    const outsideRuns = join(root, 'outside-runs');
    mkdirSync(runs, { recursive: true });
    mkdirSync(outsideRuns);
    const target = join(runs, 'run-1');
    injectedFileFailure.beforeArtifactCreation = () => {
      renameSync(runs, movedRuns);
      symlinkSync(outsideRuns, runs, 'dir');
    };

    expect(() => ensurePrivateDirectory(target)).toThrow(/parent directory identity changed/);

    expect(existsSync(join(outsideRuns, 'run-1'))).toBe(false);
  });

  itPosix('should create and repair private directory and file modes under a permissive umask', () => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-file-'));
    roots.push(root);
    const directory = join(root, 'logs');
    const file = join(directory, 'events.jsonl');
    mkdirSync(directory, { mode: 0o777 });
    writeFileSync(file, 'old\n', { mode: 0o666 });
    chmodSync(directory, 0o777);
    chmodSync(file, 0o666);
    const originalUmask = process.umask(0);
    try {
      ensurePrivateDirectory(directory);
      repairPrivateDirectory(directory);
      appendPrivateFile(file, 'next\n');
      writePrivateFile(join(directory, 'debug.log'), 'debug\n');
    } finally {
      process.umask(originalUmask);
    }

    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, 'debug.log')).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['append', (path: string) => appendPrivateFile(path, 'appended\n')],
    ['write', (path: string) => writePrivateFile(path, 'overwritten\n')],
  ])('should reject a symlink file before %s without changing its target', (_operation, write) => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-file-link-'));
    roots.push(root);
    const logs = join(root, '.takt', 'runs', 'run-1', 'logs');
    mkdirSync(logs, { recursive: true });
    const outside = join(root, 'outside.log');
    writeFileSync(outside, 'unchanged\n');
    const linkedFile = join(logs, 'events.jsonl');
    symlinkSync(outside, linkedFile);

    expect(() => write(linkedFile)).toThrow(/symlink/);
    expect(readFileSync(outside, 'utf-8')).toBe('unchanged\n');
  });

  it('should reject a symlink ancestor without changing its target directory mode or contents', () => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-directory-link-'));
    roots.push(root);
    const taktDir = join(root, '.takt');
    const outsideRuns = join(root, 'outside-runs');
    mkdirSync(taktDir);
    mkdirSync(outsideRuns, { mode: 0o755 });
    chmodSync(outsideRuns, 0o755);
    symlinkSync(outsideRuns, join(taktDir, 'runs'));
    const logs = join(taktDir, 'runs', 'run-1', 'logs');

    expect(() => ensurePrivateDirectory(logs)).toThrow(/symlink/);
    expectPosixMode(statSync(outsideRuns).mode, 0o755);
    expect(readdirSync(outsideRuns)).toEqual([]);
  });

  itPosix.each([
    ['ensure', ensurePrivateDirectory],
    ['repair', repairPrivateDirectory],
  ])('should reject an ancestor swap before %s without changing the outside directory', (_operation, secureDirectory) => {
    const root = mkdtempSync(join(TEST_TMPDIR, 'takt-private-directory-swap-'));
    roots.push(root);
    const runs = join(root, '.takt', 'runs');
    const target = join(runs, 'run-1');
    const movedRuns = join(root, 'original-runs');
    const outsideRuns = join(root, 'outside-runs');
    mkdirSync(target, { recursive: true });
    mkdirSync(join(outsideRuns, 'run-1'), { recursive: true });
    writeFileSync(join(outsideRuns, 'sentinel.txt'), 'unchanged\n');
    chmodSync(join(outsideRuns, 'run-1'), 0o755);
    injectedFileFailure.beforeOpen = () => {
      renameSync(runs, movedRuns);
      symlinkSync(outsideRuns, runs, 'dir');
    };

    expect(() => secureDirectory(target)).toThrow(/identity changed/);

    expect(statSync(join(outsideRuns, 'run-1')).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(outsideRuns, 'sentinel.txt'), 'utf-8')).toBe('unchanged\n');
    expect(readdirSync(outsideRuns).sort()).toEqual(['run-1', 'sentinel.txt']);
  });

  it.each([
    ['ensure directory', (path: string) => ensurePrivateDirectory(join(path, 'created'))],
    ['repair directory', (path: string) => repairPrivateDirectory(join(path, 'existing'))],
    ['append file', (path: string) => appendPrivateFile(join(path, 'artifact.log'), 'appended\n')],
    ['write file', (path: string) => writePrivateFile(join(path, 'artifact.log'), 'overwritten\n')],
  ])('should reject an immediate symlink parent before %s without changing its target', (_operation, access) => {
    const root = mkdtempSync(join(process.cwd(), 'takt-private-parent-link-'));
    roots.push(root);
    const outside = join(root, 'outside');
    mkdirSync(join(outside, 'existing'), { recursive: true });
    writeFileSync(join(outside, 'artifact.log'), 'unchanged\n');
    chmodSync(outside, 0o755);
    const linkedParent = join(root, 'linked-parent');
    symlinkSync(outside, linkedParent, 'dir');

    expect(() => access(linkedParent)).toThrow(/symlink/);
    expectPosixMode(statSync(outside).mode, 0o755);
    expect(readFileSync(join(outside, 'artifact.log'), 'utf-8')).toBe('unchanged\n');
    expect(readdirSync(outside).sort()).toEqual(['artifact.log', 'existing']);
  });

  it.each([
    ['ensure directory', (path: string) => ensurePrivateDirectory(join(path, 'created'))],
    ['repair directory', (path: string) => repairPrivateDirectory(join(path, 'existing'))],
    ['append file', (path: string) => appendPrivateFile(join(path, 'artifact.log'), 'appended\n')],
    ['write file', (path: string) => writePrivateFile(join(path, 'artifact.log'), 'overwritten\n')],
    ['write file with mode', (path: string) => writePrivateFileWithMode(join(path, 'artifact.log'), 'overwritten\n', 0o600)],
    ['write new file', (path: string) => writeNewPrivateFileWithMode(join(path, 'created.log'), 'created\n', 0o600)],
  ])('should reject a non-immediate symlink ancestor before %s without changing its target', (_operation, access) => {
    const root = mkdtempSync(join(process.cwd(), 'takt-private-nested-parent-link-'));
    roots.push(root);
    const outside = join(root, 'outside');
    const outsideNested = join(outside, 'nested');
    mkdirSync(join(outsideNested, 'existing'), { recursive: true });
    writeFileSync(join(outsideNested, 'artifact.log'), 'unchanged\n');
    chmodSync(outsideNested, 0o755);
    const linkedParent = join(root, 'linked-parent');
    symlinkSync(outside, linkedParent, 'dir');
    const targetParent = join(linkedParent, 'nested');

    expect(() => access(targetParent)).toThrow(/symlink/);
    expectPosixMode(statSync(outsideNested).mode, 0o755);
    expect(readFileSync(join(outsideNested, 'artifact.log'), 'utf-8')).toBe('unchanged\n');
    expect(readdirSync(outsideNested).sort()).toEqual(['artifact.log', 'existing']);
  });
});
