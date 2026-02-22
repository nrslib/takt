/**
 * Atomic package installation / replacement.
 *
 * The sequence:
 *   1. Rename existing packageDir → packageDir.bak  (backup)
 *   2. Create new empty packageDir
 *   3. Call install() which writes to packageDir
 *   4. On success: delete packageDir.bak
 *   5. On failure: delete packageDir (partial), rename .bak → packageDir (restore)
 *
 * cleanupResiduals() removes any .tmp or .bak directories left by previous
 * failed runs before starting a new installation.
 */

import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';

export interface AtomicReplaceOptions {
  /** Absolute path to the package directory (final install location). */
  packageDir: string;
  /** Callback that writes the new package content into packageDir. */
  install: () => Promise<void>;
}

/**
 * Remove any leftover .tmp or .bak directories from a previous failed installation.
 *
 * @param packageDir - absolute path to the package directory (not the .tmp/.bak path)
 */
export function cleanupResiduals(packageDir: string): void {
  const tmpPath = `${packageDir}.tmp`;
  const bakPath = `${packageDir}.bak`;

  if (existsSync(tmpPath)) {
    rmSync(tmpPath, { recursive: true, force: true });
  }
  if (existsSync(bakPath)) {
    rmSync(bakPath, { recursive: true, force: true });
  }
}

/**
 * Atomically replace a package directory.
 *
 * If the package directory already exists, it is renamed to .bak before
 * installing the new version. On success, .bak is removed. On failure,
 * the new (partial) directory is removed and .bak is restored.
 *
 * If the package directory does not yet exist, creates it fresh.
 */
export async function atomicReplace(options: AtomicReplaceOptions): Promise<void> {
  const { packageDir, install } = options;
  const bakPath = `${packageDir}.bak`;
  const hadExisting = existsSync(packageDir);

  // Step 1: backup existing package
  if (hadExisting) {
    renameSync(packageDir, bakPath);
  }

  // Step 2: create new empty package directory
  mkdirSync(packageDir, { recursive: true });

  // Step 3: run install
  try {
    await install();
  } catch (err) {
    // Step 5 (failure path): remove partial install, restore backup
    rmSync(packageDir, { recursive: true, force: true });
    if (hadExisting && existsSync(bakPath)) {
      renameSync(bakPath, packageDir);
    }
    throw err;
  }

  // Step 4: remove backup on success
  if (hadExisting && existsSync(bakPath)) {
    rmSync(bakPath, { recursive: true, force: true });
  }
}
