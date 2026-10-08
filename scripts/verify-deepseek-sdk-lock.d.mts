interface StartupManifest {
  dependencies: Record<string, string>;
  bundleDependencies: string[];
}

interface StartupLock {
  packages: Record<string, {
    version?: string;
    dependencies?: Record<string, string>;
  }>;
}

export function verifyStartupBundleLock(root: StartupManifest, lock: StartupLock): void;
export function verifyDeepSeekPackAssets(files: { path: string }[], root: StartupManifest): void;
