#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const INSTALL_NPM_VERSIONS = ['10.9.4', '11.16.0', '12.2.0'];
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const { values } = parseArgs({ options: {
  tarball: { type: 'string' },
  'from-version': { type: 'string' },
  'history-version': { type: 'string' },
  'npm-versions': { type: 'string' },
  route: { type: 'string' },
  'log-dir': { type: 'string' },
} });
const versions = values['npm-versions']?.split(',') ?? INSTALL_NPM_VERSIONS;
const routes = values.route ? [values.route] : ['fresh', 'overwrite'];
if (routes.some((route) => !['fresh', 'overwrite'].includes(route))) throw new Error('route must be fresh or overwrite');
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const logRoot = resolve(values['log-dir'] ?? join(repoRoot, '.takt', 'global-install-logs', `${Date.now()}-${process.pid}`));
mkdirSync(logRoot, { recursive: true });
const workRoot = mkdtempSync(join(tmpdir(), 'takt-global-install-check-'));
process.stdout.write(`[takt] global install logs: ${logRoot}\n`);

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

function inspect(name, command, args, cwd, env) {
  let result;
  try {
    const execution = spawnSync(command, args, {
      cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600000, maxBuffer: 32 * 1024 * 1024,
    });
    result = {
      status: execution.status ?? 1,
      stdout: execution.stdout ?? '',
      stderr: `${execution.error ? `${execution.error}\n` : ''}${execution.stderr ?? ''}`,
    };
  } catch (error) {
    result = { status: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: `${error}\n${error.stderr ?? ''}` };
  }
  writeFileSync(join(logRoot, `${name}.json`), JSON.stringify({ command, args, cwd, ...result }, null, 2));
  process.stdout.write(`[takt] ${name}: exit ${result.status}\n${result.stdout}\n${result.stderr}\n`);
  return result;
}

function installPublishedVersion(name, version, installArgs, installed, env) {
  const result = inspect(`${name}-install`, 'npx', [...installArgs, `takt@${version}`], workRoot, env);
  if (result.status !== 0) return false;
  try {
    const manifest = readFileSync(join(installed, 'package.json'), 'utf8');
    writeFileSync(join(logRoot, `${name}-manifest.json`), manifest);
    const actual = JSON.parse(manifest).version;
    if (actual !== version) throw new Error(`installed ${actual}, expected ${version}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[takt] ${name} (takt@${version}): ${message}\n`);
    return false;
  }
  writeFileSync(join(logRoot, `${name}-empty-directories.json`), JSON.stringify(findEmptyDirectories(join(installed, 'node_modules')), null, 2));
  return true;
}

try {
  let tarball = values.tarball && resolve(values.tarball);
  if (!tarball) {
    execFileSync('npm', ['pack', '--pack-destination', workRoot], { cwd: repoRoot, stdio: ['ignore', 'ignore', 'inherit'] });
    const filename = readdirSync(workRoot).find((name) => name.endsWith('.tgz'));
    if (filename === undefined) throw new Error('npm pack did not produce a tarball');
    tarball = join(workRoot, filename);
  }
  const fromVersion = values['from-version'] ?? execFileSync('npm', ['view', 'takt@latest', 'version', '--prefer-online'], { encoding: 'utf8' }).trim();
  const historyVersion = values['history-version'];
  if (!VERSION_PATTERN.test(fromVersion)) throw new Error(`Invalid starting version: ${fromVersion}`);
  if (historyVersion !== undefined && !VERSION_PATTERN.test(historyVersion)) throw new Error(`Invalid history version: ${historyVersion}`);
  process.stdout.write(`[takt] starting version: ${fromVersion}; tarball: ${tarball}; Node: ${process.version}\n`);
  writeFileSync(join(logRoot, 'input.json'), JSON.stringify({ fromVersion, historyVersion, tarball, versions, routes, node: process.version }, null, 2));
  const env = { ...process.env, QUINT_HOME: process.env.QUINT_HOME ?? join(workRoot, 'quint-home') };
  let failed = false;
  for (const version of versions) {
    for (const route of routes) {
      const name = `npm-${version}-${route}`;
      const prefix = join(workRoot, name);
      const npmArgs = ['--yes', `npm@${version}`];
      const installArgs = [...npmArgs, 'install', '--global', '--prefix', prefix, '--cache', join(workRoot, `cache-${version}`)];
      const installed = join(prefix, 'lib', 'node_modules', 'takt');
      if (route === 'overwrite') {
        if (historyVersion !== undefined && !installPublishedVersion(`${name}-history`, historyVersion, installArgs, installed, env)) {
          failed = true;
          continue;
        }
        if (!installPublishedVersion(`${name}-initial`, fromVersion, installArgs, installed, env)) {
          failed = true;
          continue;
        }
      }
      const installation = inspect(`${name}-install`, 'npx', [...installArgs, tarball], workRoot, env);
      if (installation.status !== 0) { failed = true; continue; }
      let empty;
      try {
        empty = findEmptyDirectories(join(installed, 'node_modules'));
        writeFileSync(join(logRoot, `${name}-empty-directories.json`), JSON.stringify(empty, null, 2));
        if (empty.length > 0) throw new Error(`empty directories in the installed package:\n${empty.join('\n')}`);
      } catch (error) {
        failed = true;
        process.stderr.write(`[takt] ${name}: ${error}\n`);
      }
      const dependencies = inspect(`${name}-npm-ls`, 'npx', [...npmArgs, 'ls', '--global', '--prefix', prefix, '--all', '--json'], workRoot, env);
      const quint = inspect(`${name}-quint`, process.execPath, [join(repoRoot, 'scripts/global-install-quint-smoke.mjs'), installed], workRoot, env);
      const startup = empty?.length === 0
        ? inspect(`${name}-startup`, process.execPath, [join(repoRoot, 'scripts/global-install-smoke.mjs'), installed], workRoot, env)
        : undefined;
      if (dependencies.status !== 0 || quint.status !== 0 || startup?.status !== 0) failed = true;
    }
  }
  if (failed) process.exitCode = 1;
  else process.stdout.write('[takt] global install check passed\n');
} finally {
  // Diagnostics live outside this disposable installation root, including on failure.
  try {
    for (const version of versions) {
      const logs = join(workRoot, `cache-${version}`, '_logs');
      if (existsSync(logs)) cpSync(logs, join(logRoot, `npm-${version}-logs`), { recursive: true });
    }
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}
