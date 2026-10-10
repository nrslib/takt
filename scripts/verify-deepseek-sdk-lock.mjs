#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const sdkVersion = '0.2.0-rc.2';
const managedBase = 'managed/deepseek-harness/';

export function verifyDeepSeekManagedLock(root, managed, lock, constants) {
  if (Object.keys(root.dependencies).some((name) => name.startsWith('@deepseek-ai/'))
    || root.bundleDependencies?.some((name) => name.startsWith('@deepseek-ai/'))
    || !(root.files.includes(managedBase) || root.files.includes('managed/'))) {
    throw new Error('The TAKT package must ship the managed assets without production DeepSeek dependencies');
  }
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-sdk-client']) {
    if (managed.dependencies[name] !== sdkVersion || root.devDependencies[name] !== sdkVersion) {
      throw new Error(`${name} must be pinned for managed runtime and development types`);
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
    const pinned = name === '@deepseek-ai/cordis' ? '4.0.4' : version;
    if (managed.dependencies[name] !== pinned) {
      throw new Error(`${name} SDK peer must be explicitly pinned in the managed npm project`);
    }
  }
}

export function verifyStartupBundleLock(root, lock) {
  for (const name of ['@modelcontextprotocol/sdk', 'ink', 'react']) {
    const version = lock.packages?.[`node_modules/${name}`]?.version;
    if (!version
      || root.dependencies?.[name] !== version
      || lock.packages?.['']?.dependencies?.[name] !== version
      || !root.bundleDependencies?.includes(name)) {
      throw new Error(`${name} must be explicitly pinned, locked and bundled`);
    }
  }
}

export function verifyDeepSeekPackAssets(files, root) {
  const paths = new Set(files.map((file) => file.path));
  for (const provider of ['deepseek-harness', 'claude-sdk', 'codex', 'opencode', 'pi']) {
    for (const name of ['package.json', 'package-lock.json']) {
      if (!paths.has(`managed/${provider}/${name}`)) {
        throw new Error(`${provider} managed ${name} is missing from npm pack`);
      }
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
  verifyDeepSeekManagedLock(root, managed, lock, constants);
  verifyStartupBundleLock(root, rootLock);
  for (const provider of ['claude-sdk', 'codex', 'opencode', 'pi']) {
    const manifest = JSON.parse(readFileSync(new URL(`../managed/${provider}/package.json`, import.meta.url), 'utf8'));
    const managedLock = JSON.parse(readFileSync(new URL(`../managed/${provider}/package-lock.json`, import.meta.url), 'utf8'));
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version)
        || root.devDependencies?.[name] !== version
        || root.dependencies?.[name] !== undefined
        || root.optionalDependencies?.[name] !== undefined
        || root.bundleDependencies?.includes(name)
        || rootLock.packages?.[`node_modules/${name}`]?.dev !== true
        || managedLock.packages?.['']?.dependencies?.[name] !== version
        || managedLock.packages?.[`node_modules/${name}`]?.version !== version) {
        throw new Error(`${name} must be pinned in ${provider} managed assets and excluded from production dependencies`);
      }
    }
  }
  if (process.argv.includes('--pack')) {
    const inventory = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    }));
    verifyDeepSeekPackAssets(inventory[0].files, root);
  }
  process.stdout.write(`Managed provider npm locks verified (DeepSeek ${sdkVersion})\n`);
}
