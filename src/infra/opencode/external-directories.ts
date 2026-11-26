import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, sep } from 'node:path';

export function normalizeOpenCodeWorkspaceDirectories(directories: readonly string[]): string[] {
  return normalizeDirectories(directories, false);
}

function resolveRequestedDirectory(directory: string): string {
  const missing: string[] = [];
  let ancestor = directory;
  while (true) {
    try { return join(realpathSync(ancestor), ...missing); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

export function isOpenCodeExternalDirectoryRequestAllowed(resources: readonly string[], directories: readonly string[]): boolean {
  if (resources.length === 0) return false;
  return resources.every((resource) => {
    if (!resource.endsWith('/*')) return false;
    const directory = resource.slice(0, -1);
    if (!isAbsolute(directory)) return false;
    const canonical = resolveRequestedDirectory(directory);
    return directories.some((root) => {
      if (!isAbsolute(root)) return false;
      const child = relative(root, canonical);
      return child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
    });
  });
}

export function normalizeOpenCodeExternalDirectories(
  directories: readonly string[] | undefined,
): string[] {
  return normalizeDirectories(directories ?? [], true);
}

function normalizeDirectories(directories: readonly string[], forPatterns: boolean): string[] {
  const normalized = new Set<string>();
  for (const directory of directories) {
    if (!isAbsolute(directory)) {
      throw new Error(`OpenCode external directory must be absolute: ${directory}`);
    }
    if (forPatterns && (directory.includes('*') || directory.includes('?'))) {
      throw new Error(`OpenCode external directory cannot contain wildcard characters: ${directory}`);
    }
    // V2 resolves external paths before matching permission patterns.
    const canonical = realpathSync(directory);
    if (forPatterns && canonical === parse(canonical).root) {
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
  workspaceDirectories?: readonly string[],
): {
  external_directory: 'deny' | 'ask' | Record<string, 'allow' | 'deny'>;
} {
  const normalized = normalizeOpenCodeExternalDirectories(directories);
  if (workspaceDirectories !== undefined) return { external_directory: 'ask' };
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
  workspaceDirectories?: readonly string[],
): Array<{ action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }> {
  const normalized = normalizeOpenCodeExternalDirectories(directories);
  // Workspace access must not override the context's edit restriction.
  return [
    { action: 'external_directory', resource: '*', effect: workspaceDirectories === undefined ? 'deny' : 'ask' },
    ...(workspaceDirectories === undefined ? normalized : []).map((directory) => ({
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
