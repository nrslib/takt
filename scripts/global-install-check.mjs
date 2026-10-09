#!/usr/bin/env node

// Packs the built tree and checks a fresh global install with each npm major that users run,
// the same way the CI "Global install of packed TAKT" job does. A lockfile change can move
// bundled dependencies and break only the installed package, which no in-repo test sees.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALL_NPM_VERSIONS = ['10.9.4', '11.16.0'];

function findEmptyDirectories(root) {
  const empty = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.length === 0) empty.push(directory);
    for (const entry of entries) {
      if (entry.isDirectory()) visit(join(directory, entry.name));
    }
  };
  visit(root);
  return empty;
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const workRoot = mkdtempSync(join(tmpdir(), 'takt-global-install-check-'));
try {
  execFileSync('npm', ['pack', '--pack-destination', workRoot], { cwd: repoRoot, stdio: ['ignore', 'ignore', 'inherit'] });
  const tarball = readdirSync(workRoot).find((name) => name.endsWith('.tgz'));
  if (tarball === undefined) throw new Error('npm pack did not produce a tarball');

  for (const version of INSTALL_NPM_VERSIONS) {
    const prefix = join(workRoot, `prefix-${version}`);
    process.stdout.write(`[takt] global install with npm ${version}\n`);
    execFileSync('npx', [
      '--yes', `npm@${version}`, 'install', '--global',
      '--prefix', prefix,
      '--cache', join(workRoot, `cache-${version}`),
      join(workRoot, tarball),
    ], { cwd: workRoot, stdio: 'inherit' });

    const installed = join(prefix, 'lib', 'node_modules', 'takt');
    const empty = findEmptyDirectories(join(installed, 'node_modules'));
    if (empty.length > 0) {
      throw new Error(`npm ${version} left empty directories in the installed package:\n${empty.join('\n')}`);
    }
    execFileSync(process.execPath, [join(repoRoot, 'scripts', 'global-install-smoke.mjs'), installed], { stdio: 'inherit' });
  }
  process.stdout.write('[takt] global install check passed\n');
} finally {
  rmSync(workRoot, { recursive: true, force: true });
}
