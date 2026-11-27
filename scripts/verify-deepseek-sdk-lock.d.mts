type ManifestOverrideValue = string | Record<string, string>;

interface StartupManifest {
  dependencies: Record<string, string>;
  bundleDependencies: string[];
  overrides?: Record<string, ManifestOverrideValue>;
}

interface StartupLock {
  packages: Record<string, {
    version?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  }>;
}

interface DeepSeekRootManifest extends StartupManifest {
  optionalDependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
  files: string[];
}

interface DeepSeekManagedManifest {
  dependencies: Record<string, string>;
  overrides?: Record<string, ManifestOverrideValue>;
}

/** Verify the managed SDK graph and reject root DeepSeek dependencies or version, peer, and shipping inconsistencies. */
export function verifyDeepSeekManagedLock(
  root: DeepSeekRootManifest,
  rootLock: StartupLock,
  managed: DeepSeekManagedManifest,
  lock: StartupLock,
  constants: string,
): void;
/** Require startup dependencies to be exactly pinned, locked, and bundled; throw on inconsistencies. */
export function verifyStartupBundleLock(root: StartupManifest, lock: StartupLock, quint: { dependencies: Record<string, string> }): void;
/** Verify managed assets and declared startup bundles are in the pack inventory; throw if missing. */
export function verifyDeepSeekPackAssets(files: { path: string }[], root: StartupManifest): void;
