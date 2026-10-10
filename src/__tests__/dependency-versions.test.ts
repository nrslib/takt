import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ts from 'typescript';

type PackageJson = {
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  bundleDependencies?: string[];
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
};

type PackageLock = {
  packages?: Record<string, {
    version?: string;
    engines?: Record<string, string>;
    resolved?: string;
    integrity?: string;
    dev?: boolean;
  }>;
};

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as PackageJson;
}

function readPackageLock(): PackageLock {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'package-lock.json'), 'utf-8'),
  ) as PackageLock;
}

function getLockedPackage(packageLock: PackageLock, path: string): {
  version?: string;
  engines?: Record<string, string>;
} {
  const lockedPackage = packageLock.packages?.[path];
  if (!lockedPackage) {
    throw new Error(`${path} is not present in package-lock.json`);
  }
  return lockedPackage;
}

type NodeVersion = readonly [number, number, number];

function parseNodeVersion(version: string): NodeVersion {
  const normalized = version.replace(/^[vV]/, '');
  const parts = normalized.split('.');
  if (parts.length > 3 || parts.length === 0) {
    throw new Error(`Unsupported Node version: ${version}`);
  }

  return [parseVersionPart(parts[0]), parseVersionPart(parts[1]), parseVersionPart(parts[2])];
}

function parseVersionPart(part: string | undefined): number {
  if (part === undefined) {
    return 0;
  }
  if (!/^\d+$/.test(part)) {
    throw new Error(`Unsupported Node version part: ${part}`);
  }
  return Number(part);
}

/** Compares parsed versions numerically, including multi-digit minor versions. */
function compareNodeVersions(left: NodeVersion, right: NodeVersion): number {
  for (const index of [0, 1, 2] as const) {
    const difference = left[index] - right[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function getMinimumNodeVersion(range: string): NodeVersion {
  const alternatives = range.split('||').map((alternative) => {
    const normalized = alternative.trim().replace(/([<>=]=?|\^)\s+/g, '$1');
    const match = normalized.match(/^(?:>=|\^)(\d+(?:\.\d+){0,2})(?:\s+<\d+(?:\.\d+){0,2})?$/);
    if (!match?.[1]) {
      throw new Error(`Root Node engine must be a lower-bound range: ${range}`);
    }
    return parseNodeVersion(match[1]);
  });

  return alternatives.reduce((minimum, alternative) => (
    compareNodeVersions(alternative, minimum) < 0 ? alternative : minimum
  ));
}

function satisfiesNodeRange(version: NodeVersion, range: string): boolean {
  return range.split('||').some((alternative) => satisfiesNodeAlternative(version, alternative));
}

function satisfiesNodeAlternative(version: NodeVersion, alternative: string): boolean {
  const normalized = alternative.trim().replace(/([<>=]=?|\^)\s+/g, '$1');
  if (!normalized) {
    throw new Error(`Unsupported empty Node engine range: ${alternative}`);
  }

  return normalized.split(/\s+/).every((comparator) => satisfiesNodeComparator(version, comparator));
}

function satisfiesNodeComparator(version: NodeVersion, comparator: string): boolean {
  if (comparator.startsWith('>=')) {
    return compareNodeVersions(version, parseNodeVersion(comparator.slice(2))) >= 0;
  }
  if (comparator.startsWith('>')) {
    return compareNodeVersions(version, parseNodeVersion(comparator.slice(1))) > 0;
  }
  if (comparator.startsWith('<=')) {
    return compareNodeVersions(version, parseNodeVersion(comparator.slice(2))) <= 0;
  }
  if (comparator.startsWith('<')) {
    return compareNodeVersions(version, parseNodeVersion(comparator.slice(1))) < 0;
  }
  if (comparator.startsWith('^')) {
    const minimum = parseNodeVersion(comparator.slice(1));
    return compareNodeVersions(version, minimum) >= 0
      && compareNodeVersions(version, getCaretUpperBound(minimum)) < 0;
  }
  return compareNodeVersions(version, parseNodeVersion(comparator)) === 0;
}

function getCaretUpperBound(version: NodeVersion): NodeVersion {
  if (version[0] > 0) {
    return [version[0] + 1, 0, 0];
  }
  if (version[1] > 0) {
    return [0, version[1] + 1, 0];
  }
  return [0, 0, version[2] + 1];
}

describe('dependency versions', () => {
  it.each(['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent'])(
    'keeps %s available for development without including it in a production install',
    (packageName) => {
      const manifest = readPackageJson();
      const packageLock = readPackageLock();
      const copies = Object.entries(packageLock.packages ?? {})
        .filter(([packagePath]) => packagePath.endsWith(`node_modules/${packageName}`));
      const taktProcessCopies = copies.filter(([packagePath]) => (
        !packagePath.includes('node_modules/@deepseek-ai/dsh-llm-pi-ai/node_modules/')
      ));

      expect(manifest.dependencies?.[packageName]).toBeUndefined();
      expect(manifest.devDependencies?.[packageName]).toBeDefined();
      expect(packageLock.packages?.[`node_modules/${packageName}`]?.version).toBe('1.0.2');
      expect(taktProcessCopies.length).toBeGreaterThan(0);
      for (const [, lockedPackage] of taktProcessCopies) {
        expect(lockedPackage.version).toBe('1.0.2');
        expect(lockedPackage.dev).toBe(true);
      }
    },
  );

  it('records integrity for registry tarballs required by the Nix dependency fetcher', () => {
    const packages = Object.entries(readPackageLock().packages ?? {});
    const registryPackages = packages.filter(([, info]) => (
      info.resolved?.startsWith('https://registry.npmjs.org/')
    ));

    expect(registryPackages.length).toBeGreaterThan(0);
    expect(registryPackages.filter(([, info]) => !info.integrity)
      .map(([packagePath]) => packagePath)).toEqual([]);
  });

  it('declares Node support compatible with runtime dependency engines', () => {
    const packageJson = readPackageJson();
    const packageLock = readPackageLock();
    const dependencies = packageJson.dependencies;
    const rootNodeRange = packageJson.engines?.node;
    if (!dependencies) {
      throw new Error('package.json dependencies are required');
    }
    if (!rootNodeRange) {
      throw new Error('package.json engines.node is required');
    }

    const rootMinimum = getMinimumNodeVersion(rootNodeRange);
    const incompatibleDependencies = Object.keys(dependencies).sort().flatMap((dependencyName) => {
      const lockedPackage = getLockedPackage(packageLock, `node_modules/${dependencyName}`);
      const dependencyNodeRange = lockedPackage.engines?.node;
      if (!dependencyNodeRange) {
        return [];
      }
      if (!lockedPackage.version) {
        throw new Error(`${dependencyName} is missing a locked version`);
      }
      if (satisfiesNodeRange(rootMinimum, dependencyNodeRange)) {
        return [];
      }
      return [`${dependencyName}@${lockedPackage.version} requires ${dependencyNodeRange}`];
    });

    expect(incompatibleDependencies).toEqual([]);
  });

  it('resolves traced-config through its public entrypoint', () => {
    const stdout = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const resolved = import.meta.resolve('traced-config'); const mod = await import('traced-config'); process.stdout.write(JSON.stringify({ resolved, hasFactory: typeof mod.tracedConfig === 'function' }));",
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
      },
    );

    const result = JSON.parse(stdout) as { resolved: string; hasFactory: boolean };
    expect(result.resolved.startsWith('file://')).toBe(true);
    expect(result.hasFactory).toBe(true);
  });
});

describe('managed provider distribution', () => {
  const providers = [
    ['claude-sdk', ['@anthropic-ai/claude-agent-sdk']],
    ['codex', ['@openai/codex-sdk']],
    ['opencode', ['@opencode-ai/sdk', '@opencode/client']],
    ['pi', ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent']],
  ] as const;

  it.each(providers)('ships pinned manifests and locks for %s independently of production dependencies', (provider, packages) => {
    const root = readPackageJson();
    const managed = JSON.parse(readFileSync(join(process.cwd(), 'managed', provider, 'package.json'), 'utf8')) as PackageJson;
    const lock = JSON.parse(readFileSync(join(process.cwd(), 'managed', provider, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };
    for (const name of packages) {
      expect(root.dependencies?.[name]).toBeUndefined();
      expect(root.optionalDependencies?.[name]).toBeUndefined();
      expect(root.bundleDependencies).not.toContain(name);
      const version = managed.dependencies?.[name];
      expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u);
      expect(lock.packages['']?.dependencies?.[name]).toBe(version);
      expect(lock.packages[`node_modules/${name}`]?.version).toBe(version);
    }
  });

  it('omits SDKs and provider CLI binaries from the production lock dependency graph', () => {
    const forbidden = /node_modules\/(?:@anthropic-ai\/claude-(?:agent-sdk|code)(?:-[^/]+)?|@openai\/codex(?:-sdk|-[^/]+)?|@opencode-ai\/sdk|@opencode\/client|@earendil-works\/pi-(?:ai|coding-agent))$/u;
    const productionPackages = Object.entries(readPackageLock().packages ?? {})
      .filter(([path, record]) => forbidden.test(path) && record.dev !== true)
      .map(([path]) => path);
    expect(productionPackages).toEqual([]);
  });

  it('does not install managed providers through npm lifecycle scripts', () => {
    const scripts = readPackageJson().scripts;
    for (const name of ['preinstall', 'install', 'postinstall']) {
      expect(scripts?.[name]).toBeUndefined();
    }
  });

  it.each(['claude-sdk', 'codex'])('locks the CLI binary as part of the managed %s installation', (provider) => {
    const lock = JSON.parse(readFileSync(join(process.cwd(), 'managed', provider, 'package-lock.json'), 'utf8')) as PackageLock;
    const binary = provider === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-agent-sdk';
    const packages = Object.keys(lock.packages ?? {});
    expect(packages.some((path) => path.includes(`node_modules/${binary}-`))).toBe(true);
  });
});

describe('managed provider public boundary', () => {
  const repositoryRoot = resolve('.');
  let generatedRoot: string;
  let generatedPackage: string;

  function compileIsolatedPackage(): void {
    mkdirSync(generatedPackage, { recursive: true });
    const manifest = JSON.parse(
      readFileSync(join(repositoryRoot, 'package.json'), 'utf-8'),
    ) as PackageJson;
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
    cpSync(join(repositoryRoot, 'managed'), join(generatedPackage, 'managed'), { recursive: true });
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
    generatedRoot = mkdtempSync(join(tmpdir(), 'takt-managed-package-artifact-'));
    generatedPackage = join(generatedRoot, 'package');
    compileIsolatedPackage();
  }, 30_000);

  afterAll(() => {
    rmSync(generatedRoot, { recursive: true, force: true });
  });

  it.each(['public API', 'takt', 'takt-cli', 'takt-acp', 'takt-mcp'])('starts %s without provider SDK packages', (entrypoint) => {
    const hookPath = join(generatedRoot, 'without-provider-sdks.mjs');
    writeFileSync(hookPath, `import { registerHooks } from 'node:module';
const packages = ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk', '@opencode-ai/sdk', '@opencode/client', '@earendil-works/pi-ai', '@earendil-works/pi-coding-agent'];
registerHooks({ resolve(specifier, context, next) {
  if (packages.some(name => specifier === name || specifier.startsWith(name + '/'))) {
    throw new Error('Provider SDK is unavailable: ' + specifier);
  }
  const resolved = next(specifier, context);
  if (packages.some(name => decodeURIComponent(resolved.url).includes('/node_modules/' + name + '/'))) {
    throw new Error('Provider SDK is unavailable: ' + resolved.url);
  }
  return resolved;
} });
`);
    const manifest = JSON.parse(readFileSync(join(generatedPackage, 'package.json'), 'utf8')) as PackageJson;
    const executable = manifest.bin?.[entrypoint];
    if (entrypoint !== 'public API') expect(executable).toBeDefined();
    const result = entrypoint === 'public API'
      ? runNode(['--import', hookPath, '--input-type=module', '--eval',
        "const api = await import('takt'); if (typeof api.WorkflowEngine !== 'function') process.exit(2)"])
      : runNode(['--import', hookPath, join(generatedPackage, executable!), '--help']);
    expect(result.status, `${entrypoint}\n${result.stderr}`).toBe(0);
  });

  it('type-checks the public API with provider SDK declarations unavailable and skipLibCheck disabled', () => {
    const consumer = join(generatedRoot, 'type-consumer');
    mkdirSync(join(consumer, 'node_modules'), { recursive: true });
    symlinkSync(generatedPackage, join(consumer, 'node_modules', 'takt'), 'dir');
    writeFileSync(join(consumer, 'package.json'), '{"type":"module"}');
    const source = join(consumer, 'index.ts');
    writeFileSync(source, `import { WorkflowEngine, type WorkflowEngineOptions } from 'takt';
const options: WorkflowEngineOptions = { projectCwd: '/consumer' };
const engine: typeof WorkflowEngine = WorkflowEngine;
void options;
void engine;
`);
    const options: ts.CompilerOptions = {
      noEmit: true,
      strict: true,
      skipLibCheck: false,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    };
    const host = ts.createCompilerHost(options);
    const fileExists = host.fileExists.bind(host);
    const unavailable = /node_modules\/(?:@anthropic-ai\/claude-agent-sdk|@openai\/codex-sdk|@opencode-ai\/sdk|@opencode\/client|@earendil-works\/pi-(?:ai|coding-agent))(?:\/|$)/u;
    host.fileExists = (path) => !unavailable.test(path.replaceAll('\\', '/')) && fileExists(path);
    const program = ts.createProgram([source], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });

  it('preserves permission result and update structures accepted by the pinned Claude SDK', () => {
    const source = join(generatedRoot, 'permission-compatibility.mts');
    writeFileSync(source, `import type { PermissionResult as TaktResult, PermissionUpdate as TaktUpdate } from '${join(generatedPackage, 'dist/core/workflow/types.js')}';
import type { PermissionResult as SdkResult, PermissionUpdate as SdkUpdate } from '${join(repositoryRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.js')}';
declare const taktResult: TaktResult;
declare const sdkResult: SdkResult;
declare const taktUpdate: TaktUpdate;
declare const sdkUpdate: SdkUpdate;
const toSdkResult: SdkResult = taktResult;
const toTaktResult: TaktResult = sdkResult;
const toSdkUpdate: SdkUpdate = taktUpdate;
const toTaktUpdate: TaktUpdate = sdkUpdate;
// @ts-expect-error deny requires a message
const missingMessage: TaktResult = { behavior: 'deny' };
// @ts-expect-error updates require a destination
const missingDestination: TaktUpdate = { type: 'addDirectories', directories: ['/repo'] };
// @ts-expect-error rule updates require structured rules
const invalidRule: TaktUpdate = { type: 'addRules', rules: ['Read'], behavior: 'allow', destination: 'session' };
void [toSdkResult, toTaktResult, toSdkUpdate, toTaktUpdate, missingMessage, missingDestination, invalidRule];
`);
    const program = ts.createProgram([source], {
      noEmit: true, strict: true, skipLibCheck: false,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    expect(ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });
});
