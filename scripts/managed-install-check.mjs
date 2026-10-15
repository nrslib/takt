#!/usr/bin/env node

// Runs `takt install <provider>` against the real npm registry for every managed provider and
// checks that the installed runtime passes the integrity check and loads. In-repo tests install
// by copying the root node_modules, so they never see the packages managed/<provider> really ships.
// The config directory stays spelled through os.tmpdir() unresolved, which on macOS keeps the
// /var -> /private/var filesystem-root alias in the path users get.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const distUrl = (path) => pathToFileURL(join(repoRoot, 'dist', path)).href;

const { MANAGED_PROVIDERS } = await import(distUrl('infra/managed-providers/definitions.js'));
const { isSupportedDeepSeekHarnessPlatform } = await import(distUrl('infra/deepseek-harness/platform.js'));

const verifyScript = `
const provider = process.argv[1];
const loader = await import(${JSON.stringify(distUrl('infra/managed-providers/loader.js'))});
const state = await loader.inspectProviderInstallation(provider);
if (state.state !== 'ready') throw new Error(provider + ' is ' + state.state + ': ' + (state.cause?.message ?? 'no cause'));
if (provider === 'deepseek-harness') {
  const harness = await import(${JSON.stringify(distUrl('infra/deepseek-harness/managed-package.js'))});
  await harness.loadManagedDeepSeekHarnessModules();
} else {
  await loader.loadManagedSdk(provider);
}
`;

const skipped = [];
for (const provider of MANAGED_PROVIDERS) {
  if (provider === 'deepseek-harness' && !isSupportedDeepSeekHarnessPlatform(process.platform, process.arch)) {
    skipped.push(provider);
    process.stdout.write(`[takt] managed install ${provider}: skipped on ${process.platform}-${process.arch}\n`);
    continue;
  }
  const configDir = mkdtempSync(join(tmpdir(), `takt-managed-install-${provider}-`));
  try {
    process.stdout.write(`[takt] managed install ${provider}\n`);
    const env = { ...process.env, TAKT_CONFIG_DIR: configDir };
    execFileSync(process.execPath, [join(repoRoot, 'bin', 'takt'), 'install', provider], { env, stdio: 'inherit' });
    execFileSync(process.execPath, ['--input-type=module', '-e', verifyScript, provider], { env, stdio: 'inherit' });
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}
process.stdout.write(`[takt] managed install check passed${skipped.length > 0 ? ` (skipped: ${skipped.join(', ')})` : ''}\n`);
