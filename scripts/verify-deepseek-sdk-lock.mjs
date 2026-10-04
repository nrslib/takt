#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const expectedVersion = '0.2.0-rc.2';
const sdkName = '@deepseek-ai/dsh-sdk-client';
const runtimeName = '@deepseek-ai/dsh';

/** Check exact root pins and bundled resolutions, including SDK peers marked inBundle rather than peer. */
export function verifyDeepSeekSdkLock(packageManifest, lock, constants) {
  for (const name of [sdkName, runtimeName]) {
    if (packageManifest.dependencies?.[name] !== expectedVersion) {
      throw new Error(`${name} must be pinned to ${expectedVersion} in package.json`);
    }
    if (lock.packages?.[`node_modules/${name}`]?.version !== expectedVersion) {
      throw new Error(`${name} lockfile version must be ${expectedVersion}`);
    }
    if (lock.packages?.['']?.dependencies?.[name] !== expectedVersion) {
      throw new Error(`${name} root lock entry must be pinned to ${expectedVersion}`);
    }
  }

  if (!constants.includes(`DEEPSEEK_HARNESS_SDK_VERSION = '${expectedVersion}'`)
    || !constants.includes(`DEEPSEEK_HARNESS_RUNTIME_VERSION = '${expectedVersion}'`)) {
    throw new Error('DeepSeek SDK/runtime constants must match the pinned npm packages');
  }

  const sdkPeers = lock.packages['node_modules/@deepseek-ai/dsh-sdk-client'].peerDependencies;
  for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-sdk-protocol']) {
    if (sdkPeers?.[name] !== expectedVersion
      || lock.packages[`node_modules/${name}`]?.version !== expectedVersion) {
      throw new Error(`${name} SDK peer must match ${expectedVersion}`);
    }
  }
  if (sdkPeers?.['@deepseek-ai/cordis'] !== '~4.0.4') {
    throw new Error('DeepSeek SDK Cordis peer range changed; review compatibility before migration');
  }
  for (const name of Object.keys(sdkPeers)) {
    const version = name === '@deepseek-ai/cordis' ? '4.0.4' : expectedVersion;
    if (packageManifest.dependencies?.[name] !== version
      || !packageManifest.bundleDependencies?.includes(name)
      || lock.packages?.['']?.dependencies?.[name] !== version
      || lock.packages?.[`node_modules/${name}`]?.version !== version) {
      throw new Error(`${name} SDK peer must be explicitly pinned, locked and bundled`);
    }
  }
  if (packageManifest.dependencies?.['@deepseek-ai/libreoffice-kit'] !== '0.1.5') {
    throw new Error('The patched office toolkit must be explicitly pinned to 0.1.5');
  }
  // npm omits peer-only packages from a dependency bundle unless explicitly
  // bundled. The runtime loads these public services from its stock profile.
  for (const [name, version] of Object.entries(packageManifest.dependencies)) {
    if (!name.startsWith('@deepseek-ai/')) continue;
    if (!packageManifest.bundleDependencies?.includes(name)
      || lock.packages[`node_modules/${name}`]?.version !== version
      || lock.packages[''].dependencies?.[name] !== version) {
      throw new Error(`${name} publish dependency must be pinned, locked and bundled`);
    }
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.startsWith('node_modules/@deepseek-ai/') || !entry.peer) continue;
    const name = path.slice('node_modules/'.length);
    if (!packageManifest.bundleDependencies?.includes(name)
      || packageManifest.dependencies?.[name] !== entry.version) {
      throw new Error(`${name} runtime peer must be explicitly pinned and bundled`);
    }
  }
}

/** Verify the actual npm pack inventory, not only bundle declarations in the manifest. */
export function verifyDeepSeekPackInventory(packageManifest, files) {
  const paths = new Set(files.map((file) => file.path));
  for (const name of packageManifest.bundleDependencies) {
    if (!paths.has(`node_modules/${name}/package.json`)) {
      throw new Error(`${name} is missing from the npm pack inventory`);
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const packageManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const constants = readFileSync(new URL('../src/infra/deepseek-harness/constants.ts', import.meta.url), 'utf8');
  verifyDeepSeekSdkLock(packageManifest, lock, constants);
  if (process.argv.includes('--pack')) {
    const inventory = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    }));
    verifyDeepSeekPackInventory(packageManifest, inventory[0].files);
  }
  console.log(`DeepSeek TypeScript SDK/runtime lock verified at ${expectedVersion}`);
}
