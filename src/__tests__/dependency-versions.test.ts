import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type PackageJson = {
  dependencies?: Record<string, string>;
  engines?: Record<string, string>;
};

type PackageLock = {
  packages?: Record<string, { version?: string; engines?: Record<string, string> }>;
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

function compareNodeVersions(left: NodeVersion, right: NodeVersion): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function getMinimumNodeVersion(range: string): NodeVersion {
  const normalized = range.trim().replace(/^>=\s+/, '>=');
  const match = normalized.match(/^>=(\d+(?:\.\d+){0,2})$/);
  if (!match?.[1]) {
    throw new Error(`Root Node engine must be a lower-bound range: ${range}`);
  }
  return parseNodeVersion(match[1]);
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
  it('declares OpenTelemetry foundation dependencies', () => {
    const packageJson = readPackageJson();
    const packageLock = readPackageLock();

    expect(packageJson.dependencies).toHaveProperty('@opentelemetry/api');
    expect(packageJson.dependencies).toHaveProperty('@opentelemetry/sdk-node');
    expect(packageLock.packages).toHaveProperty('node_modules/@opentelemetry/api');
    expect(packageLock.packages).toHaveProperty('node_modules/@opentelemetry/sdk-node');
  });

  it('declares Node support compatible with OpenTelemetry dependency engines', () => {
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

    expect(rootNodeRange).toBe('>=18.19.0');

    const rootMinimum = getMinimumNodeVersion(rootNodeRange);
    const otelDependencies = ['@opentelemetry/api', '@opentelemetry/sdk-node'] as const;
    const incompatibleDependencies = otelDependencies.flatMap((dependencyName) => {
      if (!dependencies[dependencyName]) {
        throw new Error(`${dependencyName} is missing from package.json dependencies`);
      }
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

  it('locks yaml to the patched 2.8.3 release', () => {
    const packageLock = readPackageLock();

    expect(packageLock.packages?.['node_modules/yaml']?.version).toBe('2.8.3');
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
