import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type PackageManifest = {
  dependencies: Record<string, string>;
};

type PackageLock = {
  packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
};

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageManifest;
const lockfile = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as PackageLock;

describe('pi SDK dependency versions', () => {
  it('declares and locks both SDK packages at 1.1.0', () => {
    expect(manifest.dependencies['@earendil-works/pi-ai']).toBe('^1.1.0');
    expect(manifest.dependencies['@earendil-works/pi-coding-agent']).toBe('^1.1.0');
    expect(lockfile.packages['']?.dependencies?.['@earendil-works/pi-ai']).toBe('^1.1.0');
    expect(lockfile.packages['']?.dependencies?.['@earendil-works/pi-coding-agent']).toBe('^1.1.0');
    expect(lockfile.packages['node_modules/@earendil-works/pi-ai']?.version).toBe('1.1.0');
    expect(lockfile.packages['node_modules/@earendil-works/pi-coding-agent']?.version).toBe('1.1.0');
  });
});
