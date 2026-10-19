import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANAGED_MODULES, MANAGED_PROVIDERS } from '../infra/managed-providers/definitions.js';

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface PackageLock {
  packages: Record<string, { version?: string }>;
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

// Development tests import the SDKs from the root node_modules, while `takt install` ships managed/<provider>.
// A mismatch means the tests exercise a different SDK version than the one users receive.
describe('managed SDK versions match the root development dependencies', () => {
  it.each(MANAGED_PROVIDERS)('%s', (provider) => {
    const managed = readJson<Required<Pick<PackageManifest, 'dependencies'>>>('managed', provider, 'package.json');
    const sdkPackages = new Set<string>(
      provider === 'deepseek-harness' ? [] : MANAGED_MODULES[provider].map((module) => module.name),
    );

    for (const [name, version] of Object.entries(managed.dependencies)) {
      const declared = rootDeclaredVersion(name);
      if (declared === undefined && !sdkPackages.has(name)) continue;
      expect(declared, `${name} in package.json`).toBe(version);
      expect(rootLock.packages[`node_modules/${name}`]?.version, `${name} in package-lock.json`).toBe(version);
    }
  });
});
