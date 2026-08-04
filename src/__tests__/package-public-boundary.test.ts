import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface PackageManifest {
  readonly exports?: unknown;
  readonly bin?: Record<string, string>;
}

const repositoryRoot = resolve('.');
const generatedRoot = mkdtempSync(join(tmpdir(), 'takt-package-artifact-'));
const generatedPackage = join(generatedRoot, 'package');

function compileIsolatedPackage(): void {
  mkdirSync(generatedPackage, { recursive: true });
  const manifest = JSON.parse(
    readFileSync(join(repositoryRoot, 'package.json'), 'utf-8'),
  ) as PackageManifest;
  writeFileSync(
    join(generatedPackage, 'package.json'),
    JSON.stringify(manifest, null, 2),
  );
  const isolatedConfig = join(generatedRoot, 'tsconfig.json');
  writeFileSync(isolatedConfig, JSON.stringify({
    extends: join(repositoryRoot, 'tsconfig.json'),
    compilerOptions: {
      outDir: join(generatedPackage, 'dist'),
      declarationMap: false,
      sourceMap: false,
    },
    include: [join(repositoryRoot, 'src/**/*')],
    exclude: [
      join(repositoryRoot, 'node_modules'),
      join(repositoryRoot, 'dist'),
      join(repositoryRoot, 'src/__tests__'),
    ],
  }));
  const compile = spawnSync(
    process.execPath,
    [
      join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--project',
      isolatedConfig,
    ],
    { cwd: repositoryRoot, encoding: 'utf-8' },
  );
  if (compile.status !== 0) {
    throw new Error(`Isolated package compilation failed:\n${compile.stdout}\n${compile.stderr}`);
  }
  cpSync(join(repositoryRoot, 'bin'), join(generatedPackage, 'bin'), { recursive: true });
  cpSync(join(repositoryRoot, 'builtins'), join(generatedPackage, 'builtins'), { recursive: true });
  for (const relativePath of [
    'shared/prompts/en',
    'shared/prompts/ja',
    'shared/i18n',
    'core/runtime/presets',
  ]) {
    cpSync(
      join(repositoryRoot, 'src', relativePath),
      join(generatedPackage, 'dist', relativePath),
      { recursive: true },
    );
  }
  symlinkSync(
    join(repositoryRoot, 'node_modules'),
    join(generatedPackage, 'node_modules'),
    'dir',
  );
}

function runNode(arguments_: readonly string[]) {
  const consumer = mkdtempSync(join(tmpdir(), 'takt-package-consumer-'));
  mkdirSync(join(consumer, 'node_modules'));
  symlinkSync(generatedPackage, join(consumer, 'node_modules', 'takt'), 'dir');
  try {
    return spawnSync(process.execPath, arguments_, {
      cwd: consumer,
      encoding: 'utf-8',
    });
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}

beforeAll(() => {
  compileIsolatedPackage();
}, 30_000);

afterAll(() => {
  rmSync(generatedRoot, { recursive: true, force: true });
});

describe('package public boundary', () => {
  it('exports only the root programmatic API', () => {
    const manifest = JSON.parse(
      readFileSync(join(generatedPackage, 'package.json'), 'utf-8'),
    ) as PackageManifest;

    expect(manifest.exports).toEqual({
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
      },
      './package.json': './package.json',
    });
  });

  it.each([
    'takt/dist/core/workflow/findings/resume-capability.js',
    'takt/dist/shared/utils/private-file-lock-guard.js',
    'takt/dist/shared/utils/private-file-lock.js',
    'takt/dist/shared/utils/private-file.js',
  ])('rejects package deep import %s', (specifier) => {
    const result = runNode([
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(specifier)})`,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });

  it('keeps root import and every published executable runnable', () => {
    const rootImport = runNode([
      '--input-type=module',
      '--eval',
      "const api = await import('takt'); if (typeof api.WorkflowEngine !== 'function') process.exit(2)",
    ]);
    expect(rootImport.status, rootImport.stderr).toBe(0);

    const manifest = JSON.parse(
      readFileSync(join(generatedPackage, 'package.json'), 'utf-8'),
    ) as PackageManifest;
    expect(manifest.bin).toEqual(expect.objectContaining({
      takt: './bin/takt',
      'takt-cli': './dist/app/cli/index.js',
      'takt-acp': './dist/app/acp/index.js',
      'takt-mcp': './dist/app/mcp/index.js',
    }));
    for (const executable of Object.values(manifest.bin ?? {})) {
      const result = runNode([join(generatedPackage, executable), '--help']);
      expect(result.status, `${executable}\n${result.stderr}`).toBe(0);
    }
    const declarations = readFileSync(
      join(generatedPackage, 'dist', 'index.d.ts'),
      'utf-8',
    );
    expect(declarations).toContain('WorkflowEngine');
    expect(declarations).not.toContain('FindingResumeCapability');
    expect(declarations).not.toContain('PrivateFileExclusiveAccess');
  });
});
