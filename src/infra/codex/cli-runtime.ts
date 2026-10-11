import { statSync } from 'node:fs';
import { createRequire, findPackageJSON } from 'node:module';
import { dirname, join } from 'node:path';

function existsAs(path: string, kind: 'file' | 'directory'): boolean {
  try {
    const stat = statSync(path);
    return kind === 'file' ? stat.isFile() : stat.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Mirrors @openai/codex-sdk's native package resolution, including legacy layouts. */
export function resolveCodexSdkCli(codexPathOverride: string | undefined): {
  executablePath: string;
  pathDirs: string[];
} {
  if (codexPathOverride) return { executablePath: codexPathOverride, pathDirs: [] };
  const platform = process.platform === 'android' ? 'linux' : process.platform;
  const targets: Record<string, { triple: string; package: string }> = {
    'linux-x64': { triple: 'x86_64-unknown-linux-musl', package: '@openai/codex-linux-x64' },
    'linux-arm64': { triple: 'aarch64-unknown-linux-musl', package: '@openai/codex-linux-arm64' },
    'darwin-x64': { triple: 'x86_64-apple-darwin', package: '@openai/codex-darwin-x64' },
    'darwin-arm64': { triple: 'aarch64-apple-darwin', package: '@openai/codex-darwin-arm64' },
    'win32-x64': { triple: 'x86_64-pc-windows-msvc', package: '@openai/codex-win32-x64' },
    'win32-arm64': { triple: 'aarch64-pc-windows-msvc', package: '@openai/codex-win32-arm64' },
  };
  const target = targets[`${platform}-${process.arch}`];
  if (target === undefined) throw new Error(`Unsupported Codex platform: ${platform} (${process.arch})`);
  const sdkPackageJson = findPackageJSON('@openai/codex-sdk', import.meta.url);
  if (sdkPackageJson === undefined) throw new Error('Unable to locate the Codex SDK package');
  const sdkRequire = createRequire(join(dirname(sdkPackageJson), 'dist', 'index.js'));
  const codexRequire = createRequire(sdkRequire.resolve('@openai/codex/package.json'));
  const packageRoot = join(dirname(codexRequire.resolve(`${target.package}/package.json`)), 'vendor', target.triple);
  const binary = platform === 'win32' ? 'codex.exe' : 'codex';
  const executablePath = join(packageRoot, 'bin', binary);
  if (existsAs(executablePath, 'file') && existsAs(join(packageRoot, 'codex-package.json'), 'file')) {
    const pathDirectory = join(packageRoot, 'codex-path');
    return { executablePath, pathDirs: existsAs(pathDirectory, 'directory') ? [pathDirectory] : [] };
  }
  const legacyPath = join(packageRoot, 'codex', binary);
  if (existsAs(legacyPath, 'file')) {
    const pathDirectory = join(packageRoot, 'path');
    return { executablePath: legacyPath, pathDirs: existsAs(pathDirectory, 'directory') ? [pathDirectory] : [] };
  }
  throw new Error(`Unable to locate Codex SDK CLI binaries for ${target.triple}`);
}
