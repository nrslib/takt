#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const sdkVersion = '0.2.1-alpha.2';
const managedBase = 'managed/deepseek-harness/';

/**
 * Verify pinned SDK/runtime versions across development and managed dependency graphs.
 * Also enforce managed-only shipping, required SDK peers, and the fflate safety override.
 * @throws {Error} If a manifest, lock entry, version constant, or packaging contract is inconsistent.
 */
export function verifyDeepSeekManagedLock(root, rootLock, managed, lock, constants) {
  if (Object.keys(root.dependencies).some((name) => name.startsWith('@deepseek-ai/'))
    || Object.keys(root.optionalDependencies ?? {}).some((name) => name.startsWith('@deepseek-ai/'))
    || root.bundleDependencies?.some((name) => name.startsWith('@deepseek-ai/'))
    || !root.files.includes(managedBase)) {
    throw new Error('The TAKT package must ship the managed assets without production DeepSeek dependencies');
  }
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-sdk-client']) {
    if (managed.dependencies[name] !== sdkVersion || root.devDependencies[name] !== sdkVersion
      || rootLock.packages?.['']?.devDependencies?.[name] !== sdkVersion
      || rootLock.packages?.[`node_modules/${name}`]?.version !== sdkVersion) {
      throw new Error(`${name} must be pinned for managed runtime and development types`);
    }
  }
  for (const [name, version] of Object.entries({
    '@deepseek-ai/cordis': '4.0.5-alpha.1',
    '@deepseek-ai/dsh-llm': sdkVersion,
    '@deepseek-ai/dsh-scope': sdkVersion,
    '@deepseek-ai/dsh-session': sdkVersion,
    '@deepseek-ai/dsh-sdk-protocol': sdkVersion,
    '@deepseek-ai/dsh-subagent': sdkVersion,
  })) {
    if (root.devDependencies[name] !== version
      || rootLock.packages?.['']?.devDependencies?.[name] !== version
      || rootLock.packages?.[`node_modules/${name}`]?.version !== version
      || managed.dependencies[name] !== version) {
      throw new Error(`${name} must be pinned in the root and managed SDK dependency graphs`);
    }
  }
  if (!constants.includes(`DEEPSEEK_HARNESS_SDK_VERSION = '${sdkVersion}'`)
    || !constants.includes(`DEEPSEEK_HARNESS_RUNTIME_VERSION = '${sdkVersion}'`)) {
    throw new Error('DeepSeek SDK/runtime constants must match the managed npm package');
  }
  if (managed.overrides?.fflate !== '0.8.3'
    || lock.packages?.['node_modules/fflate']?.version !== '0.8.3') {
    throw new Error('The managed npm project must resolve fflate 0.8.3');
  }
  if (managed.dependencies['@deepseek-ai/libreoffice-kit'] !== '0.1.5') {
    throw new Error('The managed npm project must pin libreoffice-kit 0.1.5');
  }
  for (const [name, version] of Object.entries(managed.dependencies)) {
    if (lock.packages?.['']?.dependencies?.[name] !== version
      || lock.packages?.[`node_modules/${name}`]?.version !== version) {
      throw new Error(`${name} must be pinned in the managed npm lock`);
    }
  }
  const peers = lock.packages['node_modules/@deepseek-ai/dsh-sdk-client']?.peerDependencies;
  for (const [name, version] of Object.entries(peers ?? {})) {
    const pinned = name === '@deepseek-ai/cordis' ? '4.0.5-alpha.1' : version;
    if (managed.dependencies[name] !== pinned) {
      throw new Error(`${name} SDK peer must be explicitly pinned in the managed npm project`);
    }
  }
}

/**
 * Require CLI startup dependencies to be exactly pinned, locked, and bundled.
 * @throws {Error} If any required startup dependency violates the publish contract.
 */
export function verifyStartupBundleLock(root, lock) {
  // update-notifier is bundled because its boxen needs older wrap-ansi / widest-line than the bundled ink.
  // Left unbundled, a global install plans those older versions over the bundled top-level copies and
  // leaves empty nested directories, so startup fails to resolve string-width.
  for (const name of ['@modelcontextprotocol/sdk', 'ink', 'react', 'update-notifier']) {
    const version = lock.packages?.[`node_modules/${name}`]?.version;
    if (!version
      || root.dependencies?.[name] !== version
      || lock.packages?.['']?.dependencies?.[name] !== version
      || !root.bundleDependencies?.includes(name)) {
      throw new Error(`${name} must be explicitly pinned, locked and bundled`);
    }
  }
}

/**
 * Check an npm pack inventory for managed manifests and every declared startup bundle.
 * @throws {Error} If a required managed asset or bundled package manifest is missing.
 */
export function verifyDeepSeekPackAssets(files, root) {
  const paths = new Set(files.map((file) => file.path));
  for (const name of ['package.json', 'package-lock.json']) {
    if (!paths.has(`${managedBase}${name}`)) {
      throw new Error(`DeepSeek managed ${name} is missing from npm pack`);
    }
  }
  for (const name of root.bundleDependencies) {
    if (!paths.has(`node_modules/${name}/package.json`)) {
      throw new Error(`${name} bundled dependency is missing from npm pack`);
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const rootLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const managed = JSON.parse(readFileSync(new URL('../managed/deepseek-harness/package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../managed/deepseek-harness/package-lock.json', import.meta.url), 'utf8'));
  const constants = readFileSync(new URL('../src/infra/deepseek-harness/constants.ts', import.meta.url), 'utf8');
  verifyDeepSeekManagedLock(root, rootLock, managed, lock, constants);
  verifyStartupBundleLock(root, rootLock);
  if (process.argv.includes('--pack')) {
    const inventory = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    }));
    verifyDeepSeekPackAssets(inventory[0].files, root);
  }
  process.stdout.write(`DeepSeek managed npm lock verified at ${sdkVersion}\n`);
}
