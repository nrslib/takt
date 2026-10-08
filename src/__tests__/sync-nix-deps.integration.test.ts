import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const scriptSource = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/sync-nix-deps.mjs');

const oldHash = 'sha256-mKMiz0000000000000000000000000000000000000=';
const newHash = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const staleLock = `${JSON.stringify({
  name: 'fixture',
  lockfileVersion: 3,
  packages: { '': { name: 'fixture' }, 'node_modules/dep': { version: '1.0.0' } },
}, null, 2)}\n`;

function flake(fetcherVersion: number): string {
  return [
    '{',
    '  outputs = { self }: {',
    `    npmDepsHash = "${oldHash}";`,
    `    npmDepsFetcherVersion = ${fetcherVersion};`,
    '  };',
    '}',
    '',
  ].join('\n');
}

// npm stand-in: `npm update` bumps node_modules/dep from 1.0.0 to 1.1.0 in the lockfile of its cwd,
// or leaves it as is when FAKE_NPM_NOOP is set.
const fakeNpm = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG_DIR/npm-args"
[ -n "$FAKE_NPM_NOOP" ] && exit 0
sed 's/"version": "1.0.0"/"version": "1.1.0"/' package-lock.json > package-lock.json.tmp
mv package-lock.json.tmp package-lock.json
`;

// nix stand-in: records what prefetch-npm-deps would receive, then prints FAKE_NIX_HASH (default: newHash) or fails.
const fakeNix = `#!/bin/sh
printf '%s\\n' "$*" > "$FAKE_LOG_DIR/nix-args"
printf '%s' "$NPM_FETCHER_VERSION" > "$FAKE_LOG_DIR/nix-fetcher-version"
for last; do :; done
cp "$last" "$FAKE_LOG_DIR/nix-lock"
if [ -n "$FAKE_NIX_FAIL" ]; then
  echo "prefetch failed" >&2
  exit 1
fi
echo "\${FAKE_NIX_HASH:-${newHash}}"
`;

describe.skipIf(process.platform === 'win32')('sync-nix-deps CLI', () => {
  let root: string;
  let logDir: string;
  let binDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sync-nix-deps-it-'));
    logDir = join(root, 'logs');
    binDir = join(root, 'bin');
    mkdirSync(join(root, 'repo', 'scripts'), { recursive: true });
    mkdirSync(logDir);
    mkdirSync(binDir);
    copyFileSync(scriptSource, join(root, 'repo', 'scripts', 'sync-nix-deps.mjs'));
    writeFileSync(join(root, 'repo', 'package.json'), '{ "name": "fixture" }\n');
    writeFileSync(join(root, 'repo', 'package-lock.json'), staleLock);
    writeFileSync(join(root, 'repo', 'flake.nix'), flake(2));
    for (const [name, body] of [['npm', fakeNpm], ['nix', fakeNix]] as const) {
      writeFileSync(join(binDir, name), body);
      chmodSync(join(binDir, name), 0o755);
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function runSync(args: string[], env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [join(root, 'repo', 'scripts', 'sync-nix-deps.mjs'), ...args], {
      cwd: join(root, 'repo'),
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, FAKE_LOG_DIR: logDir, ...env },
    });
  }

  const repoFile = (name: string) => readFileSync(join(root, 'repo', name), 'utf8');
  const log = (name: string) => readFileSync(join(logDir, name), 'utf8');

  it('updates the lockfile, hashes the updated lock with the flake fetcher version, and saves the hash', () => {
    writeFileSync(join(root, 'repo', 'flake.nix'), flake(3));

    const result = runSync([]);

    expect(result.status, result.stderr).toBe(0);
    expect(log('npm-args').trim()).toBe('update --package-lock-only --ignore-scripts');
    expect(repoFile('package-lock.json')).toContain('"version": "1.1.0"');
    expect(log('nix-args')).toContain('nixpkgs#prefetch-npm-deps');
    expect(log('nix-fetcher-version')).toBe('3');
    expect(log('nix-lock')).toBe(repoFile('package-lock.json'));
    expect(repoFile('flake.nix')).toContain(`npmDepsHash = "${newHash}";`);
    expect(readdirSync(join(root, 'repo')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('exits non-zero and leaves flake.nix unchanged when the hash computation fails', () => {
    const result = runSync([], { FAKE_NIX_FAIL: '1' });

    expect(result.status).not.toBe(0);
    expect(repoFile('flake.nix')).toBe(flake(2));
  });

  it('reports the drift with --check and exits 1 without touching the working tree', () => {
    const result = runSync(['--check']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('changed node_modules/dep 1.0.0 -> 1.1.0');
    expect(result.stderr).toContain(`npmDepsHash: ${oldHash} -> ${newHash}`);
    expect(log('nix-fetcher-version')).toBe('2');
    expect(repoFile('package-lock.json')).toBe(staleLock);
    expect(repoFile('flake.nix')).toBe(flake(2));
  });

  it('exits 0 with --check when neither the lockfile nor the hash would change', () => {
    const result = runSync(['--check'], { FAKE_NPM_NOOP: '1', FAKE_NIX_HASH: oldHash });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('package-lock.json is out of date');
    expect(result.stderr).not.toContain('npmDepsHash:');
    expect(repoFile('package-lock.json')).toBe(staleLock);
    expect(repoFile('flake.nix')).toBe(flake(2));
  });

  it('exits 1 with --check when only the lockfile would change', () => {
    const result = runSync(['--check'], { FAKE_NIX_HASH: oldHash });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('changed node_modules/dep 1.0.0 -> 1.1.0');
    expect(result.stderr).not.toContain('npmDepsHash:');
    expect(repoFile('package-lock.json')).toBe(staleLock);
    expect(repoFile('flake.nix')).toBe(flake(2));
  });

  it('exits 1 with --check when only npmDepsHash would change', () => {
    const result = runSync(['--check'], { FAKE_NPM_NOOP: '1' });

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('package-lock.json is out of date');
    expect(result.stderr).toContain(`npmDepsHash: ${oldHash} -> ${newHash}`);
    expect(repoFile('package-lock.json')).toBe(staleLock);
    expect(repoFile('flake.nix')).toBe(flake(2));
  });
});
