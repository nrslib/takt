import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { WorkflowConfigRawSchema } from '../../../core/models/index.js';
import { isPathSafe } from '../../../infra/config/index.js';
import type { BuilderScopeRoot, RawWorkflow, ResolvedBuilderScope } from './types.js';

export function listWorkflowFiles(workflowsDir: string): string[] {
  return listFilesRecursive(workflowsDir, ['.yaml', '.yml']);
}

export function listFilesRecursive(rootDir: string, extensions?: string[]): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }
  const rootStat = lstatSync(rootDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(rootDir)) {
    const entryPath = join(rootDir, entry);
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      if (shouldSkipSnapshotDirectory(entry)) {
        continue;
      }
      files.push(...listFilesRecursive(entryPath, extensions));
      continue;
    }
    if (!extensions || extensions.includes(extname(entryPath))) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

export function existsFile(filePath: string): string[] {
  return existsSync(filePath) ? [filePath] : [];
}

export function loadRawWorkflow(filePath: string): RawWorkflow {
  return WorkflowConfigRawSchema.parse(parseYaml(readFileSync(filePath, 'utf-8')));
}

export function workflowNameForPath(filePath: string): string {
  return basename(filePath).replace(/\.ya?ml$/i, '');
}

export function isWorkflowFile(filePath: string): boolean {
  return filePath.endsWith('.yaml') || filePath.endsWith('.yml');
}

export function isFacetMarkdownFile(filePath: string): boolean {
  return filePath.endsWith('.md');
}

export function isFacetDirectoryFile(scope: ResolvedBuilderScope, filePath: string): boolean {
  const root = findBuilderRoot(scope, filePath);
  if (!root || !isFacetMarkdownFile(filePath)) {
    return false;
  }
  return formatRelative(root.rootDir, filePath).startsWith('facets/');
}

export function isBuilderManagedContentFile(filePath: string): boolean {
  return isWorkflowFile(filePath) || isFacetMarkdownFile(filePath);
}

export function findBuilderRoot(scope: ResolvedBuilderScope, filePath: string): BuilderScopeRoot | undefined {
  const resolvedFilePath = resolve(filePath);
  return scope.roots.find((candidate) => isPathSafe(candidate.rootDir, resolvedFilePath));
}

export function assertNoSymlinkInManagedPath(rootDir: string, filePath: string): void {
  if (pathHasSymlinkComponent(rootDir, filePath)) {
    throw new Error(`Workflow builder manifest path "${filePath}" contains a symlink component.`);
  }
}

export function pathHasSymlinkComponent(rootDir: string, filePath: string): boolean {
  const resolvedRootDir = resolve(rootDir);
  const relativePath = formatRelative(resolvedRootDir, resolve(filePath));
  if (relativePath.startsWith('..') || relativePath === '') {
    throw new Error(`Workflow builder manifest path "${filePath}" is outside the selected scope.`);
  }
  if (existsSync(resolvedRootDir) && lstatSync(resolvedRootDir).isSymbolicLink()) {
    return true;
  }
  let currentPath = resolvedRootDir;
  for (const segment of relativePath.split('/')) {
    currentPath = join(currentPath, segment);
    if (!existsSync(currentPath)) {
      return false;
    }
    if (lstatSync(currentPath).isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

export function assertBuilderRootIsNotSymlink(rootDir: string): void {
  if (existsSync(rootDir) && lstatSync(rootDir).isSymbolicLink()) {
    throw new Error(`Workflow builder scope root "${rootDir}" must not be a symlink.`);
  }
}

export function addMirroredBuilderPath(
  scope: ResolvedBuilderScope,
  paths: Set<string>,
  filePath: string,
): void {
  const resolvedPath = resolve(filePath);
  paths.add(resolvedPath);
  if (scope.writeMode !== 'dual-language') {
    return;
  }
  const root = findBuilderRoot(scope, resolvedPath);
  if (!root?.lang) {
    return;
  }
  const relativePath = formatRelative(root.rootDir, resolvedPath);
  for (const candidate of scope.roots) {
    if (candidate.lang && candidate.lang !== root.lang) {
      paths.add(resolve(candidate.rootDir, relativePath));
    }
  }
}

export function removeMirroredBuilderPath(
  scope: ResolvedBuilderScope,
  paths: Set<string>,
  filePath: string,
): void {
  const mirroredPaths = new Set<string>();
  addMirroredBuilderPath(scope, mirroredPaths, filePath);
  for (const mirroredPath of mirroredPaths) {
    paths.delete(mirroredPath);
  }
}

export function isScopedReadableFile(scope: ResolvedBuilderScope, filePath: string): boolean {
  const root = findBuilderRoot(scope, filePath);
  if (!root || !existsSync(filePath)) {
    return false;
  }
  return !pathHasSymlinkComponent(root.rootDir, filePath)
    && isPathSafe(root.rootDir, realpathSync(filePath));
}

export function formatScopedPath(scope: ResolvedBuilderScope, filePath: string): string {
  const root = scope.roots.find((candidate) => isPathSafe(candidate.rootDir, filePath));
  if (!root) {
    return filePath;
  }
  const prefix = root.lang ? `${root.lang}:` : '';
  return `${prefix}${formatRelative(root.rootDir, filePath)}`;
}

export function formatRelative(rootDir: string, filePath: string): string {
  return relative(rootDir, filePath).split(sep).join('/');
}

function shouldSkipSnapshotDirectory(name: string): boolean {
  return name === '.git' || name === 'node_modules' || name === 'dist';
}
