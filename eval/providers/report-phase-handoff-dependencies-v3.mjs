import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from './report-phase-handoff-model.mjs';

const runtimePackages = ['@openai/codex-sdk', 'promptfoo', 'typescript', 'vitest', 'yaml'];

export class DependencyAuditError extends Error {}

function dependencyTree(node) {
  return {
    ...(node.version === undefined ? {} : { version: node.version }),
    ...(node.extraneous ? { extraneous: true } : {}),
    dependencies: Object.fromEntries(Object.entries(node.dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, child]) => [name, dependencyTree(child)])),
  };
}

function resolvedPackage(root, name) {
  const metadataPath = findPackageJSON(name, pathToFileURL(join(root, 'package.json')));
  assert.ok(metadataPath, 'Resolved package has no package.json: ' + name);
  const bytes = readFileSync(metadataPath);
  const metadata = JSON.parse(bytes);
  assert.equal(metadata.name, name, 'Resolved package identity differs');
  return { name, version: metadata.version, packageJsonHash: digest(bytes) };
}

export function captureExecutionDependencies(root, packages = runtimePackages) {
  try {
    const tree = JSON.parse(execFileSync('npm', ['ls', '--all', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
    return {
      node: process.version,
      npm: execFileSync('npm', ['--version'], { cwd: root, encoding: 'utf8' }).trim(),
      lockfileHash: digest(readFileSync(join(root, 'package-lock.json'))),
      installedTree: dependencyTree(tree),
      resolvedRuntimePackages: packages.map(name => resolvedPackage(root, name)),
    };
  } catch (cause) {
    throw new DependencyAuditError('Unable to audit installed execution dependencies', { cause });
  }
}

export function assertExecutionDependencies(expected, actual) {
  if (!expected) throw new DependencyAuditError('Execution dependencies were not frozen; use a new evaluation directory');
  try { assert.deepEqual(actual, expected); }
  catch (cause) { throw new DependencyAuditError('Execution dependencies differ from the frozen environment', { cause }); }
}
