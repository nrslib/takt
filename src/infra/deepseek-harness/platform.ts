const SUPPORTED_PLATFORM_MESSAGE =
  'Provider "deepseek-harness" requires the official DeepSeek Harness runtime on '
  + 'Linux x64/arm64 or macOS arm64. Windows, macOS x64, and other platforms are not supported; '
  + 'no provider fallback is available.';

export function isSupportedDeepSeekHarnessPlatform(platform: string, arch: string): boolean {
  return (
    (platform === 'linux' && (arch === 'x64' || arch === 'arm64'))
    || (platform === 'darwin' && arch === 'arm64')
  );
}

export function assertSupportedDeepSeekHarnessPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): void {
  if (isSupportedDeepSeekHarnessPlatform(platform, arch)) {
    return;
  }
  throw new Error(SUPPORTED_PLATFORM_MESSAGE);
}
