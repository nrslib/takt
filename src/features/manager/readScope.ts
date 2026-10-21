import { accessSync, constants, opendirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import type { ToolPermissionDecisionRequest } from '../../core/workflow/permission-types.js';
import { expandHomePath } from '../../infra/config/pathExpansion.js';
import { isPathInside } from '../../shared/utils/pathBoundary.js';

export const managerReadScope = Symbol('managerReadScope');
export const MANAGER_READ_SEARCH_ENTRY_LIMIT = 10_000;

export interface ManagerReadScope {
  readonly repositoryDirectories: readonly string[];
  readonly sensitivePaths: readonly string[];
}

export type ScopedReadRequest = ToolPermissionDecisionRequest & {
  readonly [managerReadScope]?: ManagerReadScope;
};

function isSensitiveName(name: string, entry: string): boolean {
  if (entry.startsWith('*') && !entry.slice(1).includes('*')) return name.endsWith(entry.slice(1));
  if (entry.endsWith('*') && !entry.slice(0, -1).includes('*')) return name.startsWith(entry.slice(0, -1));
  if (entry.includes('*')) throw new Error('Unsupported sensitive path pattern');
  return name === entry;
}

function isSensitivePath(path: string, scope: ManagerReadScope): boolean {
  return scope.sensitivePaths.some((entry) => {
    if (!entry.includes('/') && !entry.includes('\\')) {
      return path.split(sep).some((name) => isSensitiveName(name, entry));
    }
    if (entry.includes('*')) throw new Error('Unsupported sensitive path pattern');
    const expanded = expandHomePath(entry);
    const bases = isAbsolute(expanded) ? [expanded]
      : scope.repositoryDirectories.map((directory) => resolve(directory, expanded));
    return bases.some((base) => {
      if (isPathInside(base, path)) return true;
      // 存在しない追加パスも名前で保護し、存在するリンクは実体も保護する。
      try { return isPathInside(realpathSync(base), path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    });
  });
}

function absoluteTargetPath(path: string, cwd: string): string {
  // リンクの後の .. を保持し、実体解決前の字句的な正規化を避ける。
  const expanded = path === '~' ? homedir()
    : path.startsWith('~/') ? `${homedir()}${sep}${path.slice(2)}` : path;
  return isAbsolute(expanded) ? expanded : `${cwd}${sep}${expanded}`;
}

function inspectTarget(path: string, scope: ManagerReadScope): { realPath: string; directory: boolean } | undefined {
  const realPath = realpathSync.native(path);
  if (!scope.repositoryDirectories.some((root) => isPathInside(root, realPath))
    || isSensitivePath(resolve(path), scope) || isSensitivePath(realPath, scope)) return undefined;
  const stats = statSync(realPath);
  if (!stats.isFile() && !stats.isDirectory()) return undefined;
  accessSync(realPath, constants.R_OK | (stats.isDirectory() ? constants.X_OK : 0));
  return { realPath, directory: stats.isDirectory() };
}

function searchPatternIsSupported(pattern: string): boolean {
  // rg と Node の解釈が異なる除外・展開・escape は判断役へ渡す。
  return pattern.length > 0 && !isAbsolute(pattern)
    && !pattern.split('/').includes('..')
    && !/[!{}()[\]\\~\0]/u.test(pattern);
}

function selectedByPattern(path: string, pattern: string): boolean {
  // dotfile の除外規則は道具ごとに異なるため、候補から落とさない。
  return path.split(sep).some((part) => part.startsWith('.'))
    || matchesGlob(path, pattern)
    || (!pattern.includes('/') && matchesGlob(path.split(sep).at(-1)!, pattern));
}

function searchIsSafe(root: string, logicalRoot: string, searchRoot: string, pattern: string | undefined, scope: ManagerReadScope, ancestors: ReadonlySet<string>, budget: { entries: number }): boolean {
  const target = inspectTarget(root, scope);
  if (target === undefined || !target.directory || ancestors.has(target.realPath)) return false;
  const visited = new Set([...ancestors, target.realPath]);
  const directory = opendirSync(root, { bufferSize: 32 });
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      budget.entries += 1;
      if (budget.entries >= MANAGER_READ_SEARCH_ENTRY_LIMIT) return false;
      const path = join(logicalRoot, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const child = inspectTarget(path, scope);
        if (child === undefined) return false;
        if (child.directory) {
          if (!searchIsSafe(child.realPath, path, searchRoot, pattern, scope, visited, budget)) return false;
          continue;
        }
      }
      const candidate = relative(searchRoot, path);
      if ((pattern === undefined || selectedByPattern(candidate, pattern)) && inspectTarget(path, scope) === undefined) return false;
    }
    return true;
  } finally {
    directory.closeSync();
  }
}

export function isManagerReadAllowed(request: ScopedReadRequest): boolean {
  const scope = request[managerReadScope];
  if (scope === undefined || scope.repositoryDirectories.length === 0) return false;
  const input = request.toolInput;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const args = input as Record<string, unknown>;
  const read = request.toolName === 'Read';
  const path = read ? args.file_path : args.path === undefined ? request.cwd : args.path;
  if (typeof path !== 'string' || path.trim().length === 0 || path.includes('\0')) return false;
  if (!read && (typeof args.pattern !== 'string' || args.pattern.length === 0)) return false;
  const pattern = request.toolName === 'Glob' ? args.pattern : args.glob;
  if (pattern !== undefined && (typeof pattern !== 'string' || !searchPatternIsSupported(pattern))) return false;
  try {
    const target = inspectTarget(absoluteTargetPath(path, request.cwd), scope);
    if (target === undefined) return false;
    if (read) return !target.directory;
    if (request.toolName === 'Glob' && !target.directory) return false;
    if (!target.directory) return true;
    return searchIsSafe(target.realPath, target.realPath, target.realPath, pattern as string | undefined, scope, new Set(), { entries: 0 });
  } catch {
    // 解決・読取・検索範囲の確認に失敗した要求は既存の判断役が扱う。
    return false;
  }
}
