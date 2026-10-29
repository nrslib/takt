import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type PackageManifest = {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

type PackageLock = {
  packages: Record<string, {
    version?: string;
    dev?: boolean;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>;
};

const PI_SDK_VERSION = '1.4.0';
const PI_SDK_PACKAGES = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
] as const;
const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageManifest;
const lockfile = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as PackageLock;
const managedManifest = JSON.parse(
  readFileSync(join(root, 'managed/pi/package.json'), 'utf8'),
) as Pick<PackageManifest, 'dependencies'>;
const managedLockfile = JSON.parse(
  readFileSync(join(root, 'managed/pi/package-lock.json'), 'utf8'),
) as PackageLock;
const managedDeepSeekLockfile = JSON.parse(
  readFileSync(join(root, 'managed/deepseek-harness/package-lock.json'), 'utf8'),
) as PackageLock;

describe('pi SDK dependency versions', () => {
  it.each(PI_SDK_PACKAGES)('declares and locks %s at 1.4.0 for development only', (packageName) => {
    expect(manifest.dependencies[packageName]).toBeUndefined();
    expect(manifest.devDependencies[packageName]).toBe(PI_SDK_VERSION);
    expect(lockfile.packages['']?.devDependencies?.[packageName]).toBe(PI_SDK_VERSION);
    expect(lockfile.packages[`node_modules/${packageName}`]?.version).toBe(PI_SDK_VERSION);
    expect(lockfile.packages[`node_modules/${packageName}`]?.dev).toBe(true);
  });

  it.each(PI_SDK_PACKAGES)('ships %s at 1.4.0 in the managed Pi manifest and lock', (packageName) => {
    expect(managedManifest.dependencies[packageName]).toBe(PI_SDK_VERSION);
    expect(managedLockfile.packages['']?.dependencies?.[packageName]).toBe(PI_SDK_VERSION);
    expect(managedLockfile.packages[`node_modules/${packageName}`]?.version).toBe(PI_SDK_VERSION);
  });

  it('resolves the existing managed DSH Pi AI range to 1.4.0', () => {
    expect(
      managedDeepSeekLockfile.packages['node_modules/@deepseek-ai/dsh-llm-pi-ai']
        ?.dependencies?.['@earendil-works/pi-ai'],
    ).toBe('^1.0.2');
    expect(
      managedDeepSeekLockfile.packages['node_modules/@earendil-works/pi-ai']?.version,
    ).toBe(PI_SDK_VERSION);
  });
});
