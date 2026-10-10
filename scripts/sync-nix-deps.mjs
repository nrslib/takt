import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FETCHER_VERSION_LINE = /^\s*npmDepsFetcherVersion\s*=\s*(\d+)\s*;/gm;
const HASH_LINE = /^(\s*npmDepsHash\s*=\s*")[^"]*(";)/gm;

export function readNpmDepsFetcherVersion(flakeSource) {
  const matches = [...flakeSource.matchAll(FETCHER_VERSION_LINE)];
  if (matches.length !== 1) {
    throw new Error(`flake.nix must contain exactly one npmDepsFetcherVersion line, found ${matches.length}`);
  }
  return matches[0][1];
}

export function replaceNpmDepsHash(flakeSource, hash) {
  const count = [...flakeSource.matchAll(HASH_LINE)].length;
  if (count !== 1) {
    throw new Error(`flake.nix must contain exactly one npmDepsHash line, found ${count}`);
  }
  return flakeSource.replace(HASH_LINE, (_line, head, tail) => `${head}${hash}${tail}`);
}

export function summarizeLockChanges(beforeLock, afterLock) {
  const before = JSON.parse(beforeLock).packages ?? {};
  const after = JSON.parse(afterLock).packages ?? {};
  const lines = [];
  for (const [path, entry] of Object.entries(after)) {
    const old = before[path];
    if (old === undefined) {
      lines.push(`added ${path} ${entry.version ?? ''}`.trimEnd());
    } else if (old.version !== entry.version) {
      lines.push(`changed ${path} ${old.version} -> ${entry.version}`);
    }
  }
  for (const [path, entry] of Object.entries(before)) {
    if (!(path in after)) lines.push(`removed ${path} ${entry.version ?? ''}`.trimEnd());
  }
  return lines;
}

// Write next to the target and rename over it, so an interrupted write never leaves a truncated file.
function writeFileAtomic(path, content) {
  const tempPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, content);
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function updateLock(cwd) {
  execFileSync('npm', ['update', '--package-lock-only', '--ignore-scripts'], { cwd, stdio: 'inherit' });
}

function computeHash(repoRoot, lockPath, fetcherVersion) {
  const output = execFileSync(
    'nix',
    ['run', '--inputs-from', '.', 'nixpkgs#prefetch-npm-deps', '--', lockPath],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, NPM_FETCHER_VERSION: fetcherVersion },
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const hash = output.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
  if (!/^sha256-/.test(hash)) {
    throw new Error(`unexpected prefetch-npm-deps output: ${JSON.stringify(output)}`);
  }
  return hash;
}

function run(check) {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const flakePath = join(repoRoot, 'flake.nix');
  const lockPath = join(repoRoot, 'package-lock.json');
  const flake = readFileSync(flakePath, 'utf8');
  const fetcherVersion = readNpmDepsFetcherVersion(flake);

  if (!check) {
    updateLock(repoRoot);
    const updated = replaceNpmDepsHash(flake, computeHash(repoRoot, lockPath, fetcherVersion));
    if (updated !== flake) writeFileAtomic(flakePath, updated);
    return;
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'sync-nix-deps-'));
  try {
    copyFileSync(join(repoRoot, 'package.json'), join(tempDir, 'package.json'));
    copyFileSync(lockPath, join(tempDir, 'package-lock.json'));
    updateLock(tempDir);
    const tempLockPath = join(tempDir, 'package-lock.json');
    const beforeLock = readFileSync(lockPath, 'utf8');
    const afterLock = readFileSync(tempLockPath, 'utf8');
    const newHash = computeHash(repoRoot, tempLockPath, fetcherVersion);
    const hashChanged = replaceNpmDepsHash(flake, newHash) !== flake;
    const lockChanged = beforeLock !== afterLock;
    if (!lockChanged && !hashChanged) return;
    if (lockChanged) {
      console.error('package-lock.json is out of date:');
      for (const line of summarizeLockChanges(beforeLock, afterLock)) console.error(`  ${line}`);
    }
    if (hashChanged) {
      const current = /^\s*npmDepsHash\s*=\s*"([^"]*)";/m.exec(flake)?.[1];
      console.error(`npmDepsHash: ${current} -> ${newHash}`);
    }
    process.exitCode = 1;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run(process.argv.includes('--check'));
}
