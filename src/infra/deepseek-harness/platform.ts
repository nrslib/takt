import { execFileSync } from 'node:child_process';

/**
 * `sw_vers` is probed on every install and provider startup. A stalled probe
 * must not block the Node.js event loop, so the call is bounded and the
 * existing catch treats a failure as "macOS version unknown".
 */
const MACOS_VERSION_TIMEOUT_MS = 5_000;

const SUPPORTED_PLATFORM_MESSAGE =
  'Provider "deepseek-harness" requires the official DeepSeek Harness runtime on '
  + 'Linux x64/arm64 or macOS arm64. Windows, macOS x64, and other platforms are not supported; '
  + 'no provider fallback is available.';

interface DeepSeekHarnessPlatformRuntime {
  libc?: 'glibc' | 'musl';
  libcVersion?: string;
  macOSVersion?: string;
}

function parseVersion(value: string | undefined): readonly [number, number, number] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/u.exec(value.trim());
  return match === null
    ? undefined
    : [Number(match[1]), Number(match[2]), Number(match[3] ?? '0')];
}

function isAtLeast(
  value: string | undefined,
  minimum: readonly [number, number, number],
): boolean {
  const parsed = parseVersion(value);
  return parsed !== undefined
    && parsed[0] >= minimum[0]
    && (parsed[0] > minimum[0] || parsed[1] >= minimum[1])
    && (parsed[0] > minimum[0] || parsed[1] > minimum[1] || parsed[2] >= minimum[2]);
}

function detectPlatformRuntime(platform: string): DeepSeekHarnessPlatformRuntime {
  if (platform === 'linux') {
    const report = process.report?.getReport() as {
      header?: { glibcVersionRuntime?: unknown };
    } | undefined;
    const glibcVersion = report?.header?.glibcVersionRuntime;
    return typeof glibcVersion === 'string'
      ? { libc: 'glibc', libcVersion: glibcVersion }
      : {};
  }
  if (platform === 'darwin') {
    try {
      return {
        macOSVersion: execFileSync('sw_vers', ['-productVersion'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: MACOS_VERSION_TIMEOUT_MS,
        }).trim(),
      };
    } catch {
      return {};
    }
  }
  return {};
}

export function isSupportedDeepSeekHarnessPlatform(
  platform: string,
  arch: string,
  runtime?: DeepSeekHarnessPlatformRuntime,
): boolean {
  const supportedArchitecture = (
    (platform === 'linux' && (arch === 'x64' || arch === 'arm64'))
    || (platform === 'darwin' && arch === 'arm64')
  );
  if (!supportedArchitecture || runtime === undefined) {
    return supportedArchitecture;
  }
  if (platform === 'linux') {
    return runtime.libc === 'glibc' && isAtLeast(runtime.libcVersion, [2, 28, 0]);
  }
  return isAtLeast(runtime.macOSVersion, [14, 0, 0]);
}

export function assertSupportedDeepSeekHarnessPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): void {
  if (isSupportedDeepSeekHarnessPlatform(platform, arch, detectPlatformRuntime(platform))) {
    return;
  }
  throw new Error(SUPPORTED_PLATFORM_MESSAGE);
}
