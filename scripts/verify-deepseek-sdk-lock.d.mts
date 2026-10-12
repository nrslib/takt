interface StartupManifest {
  dependencies: Record<string, string>;
  bundleDependencies: string[];
}

interface StartupLock {
  packages: Record<string, {
    version?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  }>;
}

interface DeepSeekRootManifest extends StartupManifest {
  optionalDependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
  files: string[];
}

interface DeepSeekManagedManifest {
  dependencies: Record<string, string>;
  overrides?: Record<string, string>;
}

/** Verify pinned development/managed SDK graphs and throw on version, peer, or shipping inconsistencies. */
export function verifyDeepSeekManagedLock(
  root: DeepSeekRootManifest,
  rootLock: StartupLock,
  managed: DeepSeekManagedManifest,
  lock: StartupLock,
  constants: string,
): void;
/** Require startup dependencies to be exactly pinned, locked, and bundled; throw on inconsistencies. */
export function verifyStartupBundleLock(root: StartupManifest, lock: StartupLock): void;
/** Verify managed assets and declared startup bundles are in the pack inventory; throw if missing. */
export function verifyDeepSeekPackAssets(files: { path: string }[], root: StartupManifest): void;
