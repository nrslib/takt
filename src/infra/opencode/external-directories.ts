import { realpathSync } from 'node:fs';
import { isAbsolute, join, parse, relative } from 'node:path';
import { isGitRepository, resolveGitRepositoryDirectory } from '../task/repositoryDirectory.js';

export async function resolveOpenCodeWorktreeDirectory(directory: string): Promise<string> {
  const canonicalDirectory = realpathSync(directory);
  if (await isGitRepository(canonicalDirectory)) {
    return resolveGitRepositoryDirectory(canonicalDirectory);
  }
  return parse(canonicalDirectory).root;
}

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

export function openCodeExternalDirectoryEditPattern(directory: string, worktreeDirectory: string): string {
  // V1 edit and write permission checks use worktree-relative paths.
  return join(relative(realpathSync(worktreeDirectory), directory), '*');
}

export function buildOpenCodeV1ExternalDirectoryPermissions(
  directories: readonly string[] | undefined,
  worktreeDirectory?: string,
): {
  external_directory: 'deny' | Record<string, 'allow' | 'deny'>;
  edit?: Record<string, 'deny'>;
} {
  const normalized = normalizeOpenCodeExternalDirectories(directories);
  if (normalized.length === 0) return { external_directory: 'deny' };
  if (worktreeDirectory === undefined) {
    throw new Error('OpenCode worktree directory is required for external context edit rules');
  }
  const externalDirectory: Record<string, 'allow' | 'deny'> = { '*': 'deny' };
  const edit: Record<string, 'deny'> = {};
  for (const directory of normalized) {
    externalDirectory[openCodeExternalDirectoryPattern(directory)] = 'allow';
    edit[openCodeExternalDirectoryEditPattern(directory, worktreeDirectory)] = 'deny';
  }
  return {
    external_directory: externalDirectory,
    edit,
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
