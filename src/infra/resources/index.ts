/**
 * Embedded resources for takt
 *
 * Contains default piece definitions and resource paths.
 * Resources are organized into:
 * - builtins/{lang}/workflows/ - Builtin workflow YAML (loaded via fallback)
 * - builtins/{lang}/facets/personas/ - Builtin personas (loaded via fallback)
 * - builtins/{lang}/facets/policies/ - Builtin policies
 * - builtins/{lang}/facets/instructions/ - Builtin instructions
 * - builtins/{lang}/facets/knowledge/ - Builtin knowledge files
 * - builtins/{lang}/facets/output-contracts/ - Builtin output contracts
 * - builtins/project/          - Project-level template files (.gitignore)
 * - builtins/skill/            - Claude Code skill files
 */

import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Language } from '../../core/models/index.js';

/**
 * Get the resources directory path
 * Supports both development (src/) and production (dist/) environments
 */
export function getResourcesDir(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // From src/infra/resources or dist/infra/resources, go up to project root then into builtins/
  return join(currentDir, '..', '..', '..', 'builtins');
}

/**
 * Get the project resources directory path (builtins/project/)
 */
export function getProjectResourcesDir(): string {
  return join(getResourcesDir(), 'project');
}

/**
 * Get the language-specific resources directory path (builtins/{lang}/)
 */
export function getLanguageResourcesDir(lang: Language): string {
  return join(getResourcesDir(), lang);
}

/**
 * Copy project resources directory to .takt in project.
 * Only copies files that don't exist in target (e.g., .gitignore).
 */
export function copyProjectResourcesToDir(targetDir: string): void {
  const resourcesDir = getProjectResourcesDir();
  if (!existsSync(resourcesDir)) {
    return;
  }
  copyDirRecursive(resourcesDir, targetDir, {
    skipDirs: ['tasks'],
    renameMap: { dotgitignore: '.gitignore' },
  });
}

/** Files to skip during resource copy (OS-generated files) */
const SKIP_FILES = ['.DS_Store', 'Thumbs.db'];

interface CopyOptions {
  /** Directory names to skip at the top level */
  skipDirs?: string[];
  /** Overwrite existing files (default: false) */
  overwrite?: boolean;
  /** Collect copied file paths into this array */
  copiedFiles?: string[];
  /** Rename files during copy (source name → dest name) */
  renameMap?: Record<string, string>;
}

/**
 * Recursively copy directory contents.
 * @param overwrite - If false (default), skips files that already exist in target.
 *                    If true, overwrites existing files.
 */
function copyDirRecursive(srcDir: string, destDir: string, options: CopyOptions = {}): void {
  const { skipDirs = [], overwrite = false, copiedFiles, renameMap } = options;

  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  for (const entry of readdirSync(srcDir)) {
    if (SKIP_FILES.includes(entry)) continue;
    if (skipDirs.includes(entry)) continue;

    const srcPath = join(srcDir, entry);
    const destName = renameMap?.[entry] ?? entry;
    const destPath = join(destDir, destName);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, destPath, { overwrite, copiedFiles });
    } else if (overwrite || !existsSync(destPath)) {
      const content = readFileSync(srcPath);
      writeFileSync(destPath, content);
      copiedFiles?.push(destPath);
    }
  }
}
