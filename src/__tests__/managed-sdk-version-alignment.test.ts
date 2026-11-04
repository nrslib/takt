import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_HARNESS_RUNTIME_VERSION,
  DEEPSEEK_HARNESS_SDK_VERSION,
} from '../infra/deepseek-harness/constants.js';
import { MANAGED_MODULES, MANAGED_PROVIDERS } from '../infra/managed-providers/definitions.js';

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface PackageLock {
  packages: Record<string, {
    version?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>;
}

const root = process.cwd();

function readJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(root, ...segments), 'utf8')) as T;
}

const rootManifest = readJson<PackageManifest>('package.json');
const rootLock = readJson<PackageLock>('package-lock.json');

function rootDeclaredVersion(name: string): string | undefined {
  return rootManifest.devDependencies?.[name] ?? rootManifest.dependencies?.[name];
}

describe('managed SDK versions match their development or managed verification boundary', () => {
  it.each(MANAGED_PROVIDERS.filter((provider) => provider !== 'deepseek-harness'))('%s', (provider) => {
    const managed = readJson<Required<Pick<PackageManifest, 'dependencies'>>>('managed', provider, 'package.json');
    const sdkPackages = new Set<string>(MANAGED_MODULES[provider].map((module) => module.name));

    for (const [name, version] of Object.entries(managed.dependencies)) {
      const declared = rootDeclaredVersion(name);
      if (declared === undefined && !sdkPackages.has(name)) continue;
      expect(declared, `${name} in package.json`).toBe(version);
      expect(rootLock.packages[`node_modules/${name}`]?.version, `${name} in package-lock.json`).toBe(version);
    }
  });

  it('keeps DeepSeek manifest, lock, constants, and loaded SDK on the managed version', async () => {
    const managedRoot = join(root, 'managed', 'deepseek-harness');
    const managed = readJson<Required<Pick<PackageManifest, 'dependencies'>>>('managed', 'deepseek-harness', 'package.json');
    const lock = readJson<PackageLock>('managed', 'deepseek-harness', 'package-lock.json');

    for (const dependencies of [rootManifest.dependencies, rootManifest.devDependencies]) {
      expect(Object.keys(dependencies ?? {}).filter((name) => name.startsWith('@deepseek-ai/'))).toEqual([]);
    }
    expect(Object.keys(rootLock.packages).filter((path) => path.includes('node_modules/@deepseek-ai/'))).toEqual([]);
    expect(DEEPSEEK_HARNESS_SDK_VERSION).toBe('0.2.1-rc.5');
    expect(DEEPSEEK_HARNESS_RUNTIME_VERSION).toBe(DEEPSEEK_HARNESS_SDK_VERSION);

    for (const [name, version] of Object.entries(managed.dependencies)) {
      if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) {
        expect(version, `${name} in managed package.json`).toBe(DEEPSEEK_HARNESS_SDK_VERSION);
      }
      expect(lock.packages['']?.dependencies?.[name], `${name} in managed lock root`).toBe(version);
      expect(lock.packages[`node_modules/${name}`]?.version, `${name} in managed lock`).toBe(version);
    }

    const requireFromManaged = createRequire(join(managedRoot, 'package.json'));
    const sdkPackagePath = requireFromManaged.resolve('@deepseek-ai/dsh-sdk-client/package.json');
    const llmPackagePath = requireFromManaged.resolve('@deepseek-ai/dsh-llm/package.json');
    const runtimePackagePath = requireFromManaged.resolve('@deepseek-ai/dsh/package.json');
    for (const packagePath of [sdkPackagePath, llmPackagePath, runtimePackagePath]) {
      expect((JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string }).version)
        .toBe(DEEPSEEK_HARNESS_SDK_VERSION);
    }

    const sdkEntry = requireFromManaged.resolve('@deepseek-ai/dsh-sdk-client');
    const llmEntry = requireFromManaged.resolve('@deepseek-ai/dsh-llm');
    const [sdk, llmModule] = await Promise.all([
      import(pathToFileURL(sdkEntry).href) as Promise<Record<string, unknown>>,
      import(pathToFileURL(llmEntry).href) as Promise<Record<string, unknown>>,
    ]);
    expect(sdk.DeepSeekHarness).toBeTypeOf('function');
    expect(llmModule.ReasoningEffortId).toBeTypeOf('function');
  });
});
