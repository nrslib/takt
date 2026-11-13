import { realpathSync } from 'node:fs';
import { isAbsolute, join, parse } from 'node:path';

export function normalizeOpenCodeExternalDirectories(
  directories: readonly string[] | undefined,
): string[] {
  const normalized = new Set<string>();
  for (const directory of directories ?? []) {
    if (!isAbsolute(directory)) {
      throw new Error(`OpenCode external directory must be absolute: ${directory}`);
    }
    if (directory.includes('*') || directory.includes('?')) {
      throw new Error(`OpenCode external directory cannot contain wildcard characters: ${directory}`);
    }
    // V2 resolves external paths before matching permission patterns.
    const canonical = realpathSync(directory);
    if (canonical === parse(canonical).root) {
      throw new Error('OpenCode external directory cannot be a filesystem root');
    }
    normalized.add(canonical);
  }
  return [...normalized].sort();
}

export function openCodeExternalDirectoryPattern(directory: string): string {
  // OpenCode checks external directories using the directory boundary with one `*` suffix.
  return join(directory, '*');
}

export function buildOpenCodeV1ExternalDirectoryPermissions(
  directories: readonly string[] | undefined,
): {
  external_directory: 'deny' | Record<string, 'allow' | 'deny'>;
} {
  const normalized = normalizeOpenCodeExternalDirectories(directories);
  if (normalized.length === 0) return { external_directory: 'deny' };
  const externalDirectory: Record<string, 'allow' | 'deny'> = { '*': 'deny' };
  for (const directory of normalized) {
    externalDirectory[openCodeExternalDirectoryPattern(directory)] = 'allow';
  }
  return {
    external_directory: externalDirectory,
  };
}

export function buildOpenCodeV2ExternalDirectoryRules(
  directories: readonly string[] | undefined,
): Array<{ action: string; resource: string; effect: 'allow' | 'deny' }> {
  const normalized = normalizeOpenCodeExternalDirectories(directories);
  // Keep broad external access denied. Explicit exceptions only expose this run's
  // context, and direct edit operations remain denied inside that context.
  return [
    { action: 'external_directory', resource: '*', effect: 'deny' },
    ...normalized.map((directory) => ({
      action: 'external_directory',
      resource: openCodeExternalDirectoryPattern(directory),
      effect: 'allow' as const,
    })),
    ...normalized.map((directory) => ({
      action: 'edit',
      resource: openCodeExternalDirectoryPattern(directory),
      effect: 'deny' as const,
    })),
  ];
}
