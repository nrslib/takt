import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { managedProviderFor } from '../../src/infra/managed-providers/definitions.js';

declare module 'vitest' {
  export interface ProvidedContext {
    managedConfigDir: string | undefined;
  }
}

const TAKT_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/takt');

/**
 * Install the managed SDK for TAKT_E2E_PROVIDER once per run.
 * Each isolated env links its TAKT_CONFIG_DIR/<provider> to this installation.
 */
export default function setup(project: TestProject): () => void {
  const provider = process.env.TAKT_E2E_PROVIDER;
  const managed = provider === undefined ? undefined : managedProviderFor(provider);
  if (managed === undefined) {
    project.provide('managedConfigDir', undefined);
    return () => {};
  }

  const configDir = mkdtempSync(join(tmpdir(), 'takt-e2e-managed-'));
  try {
    execFileSync(process.execPath, [TAKT_BIN, 'install', managed], {
      env: { ...process.env, TAKT_CONFIG_DIR: configDir },
      stdio: 'inherit',
    });
  } catch (error) {
    rmSync(configDir, { recursive: true, force: true });
    throw new Error(`Failed to install managed provider ${managed} for E2E`, { cause: error });
  }
  project.provide('managedConfigDir', configDir);
  return () => {
    rmSync(configDir, { recursive: true, force: true });
  };
}
