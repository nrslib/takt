import { describe, expect, it } from 'vitest';
import {
  readNpmDepsFetcherVersion,
  replaceNpmDepsHash,
  summarizeLockChanges,
} from '../../scripts/sync-nix-deps.mjs';

const oldHash = 'sha256-mKMiz0000000000000000000000000000000000000=';
const newHash = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function flake(...lines: string[]): string {
  return ['{', '  outputs = { self }: {', ...lines.map((line) => `    ${line}`), '  };', '}', ''].join('\n');
}

describe('readNpmDepsFetcherVersion', () => {
  it('returns the single npmDepsFetcherVersion value as a string', () => {
    const source = flake(`npmDepsHash = "${oldHash}";`, 'npmDepsFetcherVersion = 2;');
    expect(readNpmDepsFetcherVersion(source)).toBe('2');
  });

  it('reads a value other than 2 instead of a hard-coded default', () => {
    expect(readNpmDepsFetcherVersion(flake('npmDepsFetcherVersion = 3;'))).toBe('3');
  });

  it('throws when there is no npmDepsFetcherVersion line', () => {
    expect(() => readNpmDepsFetcherVersion(flake(`npmDepsHash = "${oldHash}";`))).toThrow(/npmDepsFetcherVersion/);
  });

  it('throws when there are two or more npmDepsFetcherVersion lines', () => {
    const source = flake('npmDepsFetcherVersion = 2;', 'npmDepsFetcherVersion = 1;');
    expect(() => readNpmDepsFetcherVersion(source)).toThrow(/npmDepsFetcherVersion/);
  });
});

describe('replaceNpmDepsHash', () => {
  it('replaces only the npmDepsHash value and keeps every other line', () => {
    const source = flake('pname = "takt";', `npmDepsHash = "${oldHash}";`, 'npmDepsFetcherVersion = 2;');
    const result = replaceNpmDepsHash(source, newHash);
    expect(result).toBe(source.replace(oldHash, newHash));
    expect(result).toContain(`npmDepsHash = "${newHash}";`);
    expect(result).not.toContain(oldHash);
  });

  it('returns the source unchanged when the hash already matches', () => {
    const source = flake(`npmDepsHash = "${newHash}";`);
    expect(replaceNpmDepsHash(source, newHash)).toBe(source);
  });

  it('throws when there is no npmDepsHash line', () => {
    expect(() => replaceNpmDepsHash(flake('npmDepsFetcherVersion = 2;'), newHash)).toThrow(/npmDepsHash/);
  });

  it('throws when there are two or more npmDepsHash lines', () => {
    const source = flake(`npmDepsHash = "${oldHash}";`, `npmDepsHash = "${oldHash}";`);
    expect(() => replaceNpmDepsHash(source, newHash)).toThrow(/npmDepsHash/);
  });
});

describe('summarizeLockChanges', () => {
  function lock(packages: Record<string, string>): string {
    const entries: Record<string, { version?: string }> = { '': {} };
    for (const [name, version] of Object.entries(packages)) {
      entries[`node_modules/${name}`] = { version };
    }
    return JSON.stringify({ lockfileVersion: 3, packages: entries });
  }

  it('returns no lines when the locks have the same packages and versions', () => {
    const text = lock({ a: '1.0.0', b: '2.0.0' });
    expect(summarizeLockChanges(text, text)).toEqual([]);
  });

  it('reports a version change with the package name and both versions', () => {
    const lines = summarizeLockChanges(lock({ a: '1.0.0', b: '2.0.0' }), lock({ a: '1.0.1', b: '2.0.0' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('a');
    expect(lines[0]).toContain('1.0.0');
    expect(lines[0]).toContain('1.0.1');
  });

  it('reports an added package', () => {
    const lines = summarizeLockChanges(lock({ a: '1.0.0' }), lock({ a: '1.0.0', c: '3.0.0' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('c');
    expect(lines[0]).toContain('3.0.0');
  });

  it('reports a removed package', () => {
    const lines = summarizeLockChanges(lock({ a: '1.0.0', b: '2.0.0' }), lock({ a: '1.0.0' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('b');
    expect(lines[0]).toContain('2.0.0');
  });
});
