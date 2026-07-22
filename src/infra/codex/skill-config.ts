import {
  readdirSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CodexOptions } from '@openai/codex-sdk';
import { isPathInside, lstatIfExists } from '../../shared/utils/index.js';

const SKILL_FILE_NAME = 'SKILL.md';
// Keep TAKT's snapshot bounded by the same traversal limits as Codex Skill discovery.
const MAX_SCAN_DEPTH = 6;
const MAX_DIRECTORIES_PER_ROOT = 2_000;
const MAX_ENTRIES_PER_ROOT = 20_000;

interface SkillInheritance {
  repo: boolean;
  user: boolean;
}

interface SkillConfigInput {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  inheritance: SkillInheritance;
}

interface TraversalState {
  directories: number;
  entries: number;
}

function lstatSkillPath(targetPath: string): Stats | null {
  try {
    return lstatIfExists(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
}

function realpathIfResolvable(targetPath: string): string | undefined {
  try {
    return realpathSync(targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') {
      return undefined;
    }
    throw error;
  }
}

function statIfResolvable(targetPath: string): Stats | undefined {
  try {
    return statSync(targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') {
      return undefined;
    }
    throw error;
  }
}

function isExcludedPath(targetPath: string, excludedRoots: readonly string[]): boolean {
  return excludedRoots.some((root) => isPathInside(root, targetPath));
}

function collectSkillFiles(
  root: string,
  excludedRoots: readonly string[],
  visitedDirectories: Set<string>,
  skillFiles: Set<string>,
  state: TraversalState,
  depth: number,
): void {
  const rootStat = lstatSkillPath(root);
  if (rootStat === null) {
    return;
  }

  const realRoot = realpathIfResolvable(root);
  if (realRoot === undefined || isExcludedPath(realRoot, excludedRoots)) {
    return;
  }
  const resolvedRootStat = rootStat.isSymbolicLink() ? statIfResolvable(realRoot) : rootStat;
  if (!resolvedRootStat?.isDirectory() || visitedDirectories.has(realRoot)) {
    return;
  }
  visitedDirectories.add(realRoot);
  state.directories += 1;
  if (state.directories > MAX_DIRECTORIES_PER_ROOT) {
    throw new Error(`Codex Skill discovery exceeded ${MAX_DIRECTORIES_PER_ROOT} directories under ${root}`);
  }

  const entries = readdirSync(realRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  state.entries += entries.length;
  if (state.entries > MAX_ENTRIES_PER_ROOT) {
    throw new Error(`Codex Skill discovery exceeded ${MAX_ENTRIES_PER_ROOT} entries under ${root}`);
  }
  for (const entry of entries) {
    const entryPath = join(realRoot, entry.name);
    const realEntryPath = entry.isSymbolicLink()
      ? realpathIfResolvable(entryPath)
      : entryPath;
    if (realEntryPath === undefined || isExcludedPath(realEntryPath, excludedRoots)) {
      continue;
    }

    const entryStat = entry.isSymbolicLink() ? statIfResolvable(realEntryPath) : undefined;
    const isDirectory = entry.isDirectory() || entryStat?.isDirectory() === true;
    if (isDirectory) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      if (depth < MAX_SCAN_DEPTH) {
        collectSkillFiles(
          realEntryPath,
          excludedRoots,
          visitedDirectories,
          skillFiles,
          state,
          depth + 1,
        );
      }
      continue;
    }

    const isFile = entry.isFile() || entryStat?.isFile() === true;
    if (entry.name === SKILL_FILE_NAME && isFile) {
      skillFiles.add(realEntryPath);
    }
  }
}

function findRepositoryRoot(cwd: string): string | undefined {
  let current = cwd;
  while (true) {
    if (statIfResolvable(join(current, '.git')) !== undefined) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function getRepoSkillRoots(cwd: string): string[] {
  const realCwd = realpathSync(cwd);
  const repositoryRoot = findRepositoryRoot(realCwd);
  if (repositoryRoot === undefined) {
    return [join(realCwd, '.agents', 'skills')];
  }

  const roots: string[] = [];
  let current = realCwd;
  while (true) {
    roots.push(join(current, '.agents', 'skills'));
    if (current === repositoryRoot) {
      return roots;
    }
    current = dirname(current);
  }
}

function resolveHomeDirectory(env: Readonly<Record<string, string | undefined>>): string {
  const configuredHome = env.HOME || env.USERPROFILE;
  if (configuredHome) {
    return resolve(configuredHome);
  }
  return homedir();
}

function getUserSkillRoots(
  env: Readonly<Record<string, string | undefined>>,
): { roots: string[]; excludedRoots: string[] } {
  const home = resolveHomeDirectory(env);
  const codexHome = resolve(env.CODEX_HOME || join(home, '.codex'));
  const codexSkillsRoot = join(codexHome, 'skills');
  return {
    roots: [
      join(home, '.agents', 'skills'),
      codexSkillsRoot,
    ],
    excludedRoots: [join(codexSkillsRoot, '.system')],
  };
}

export function buildCodexSkillConfig(input: SkillConfigInput): CodexOptions['config'] | undefined {
  if (input.inheritance.repo && input.inheritance.user) {
    return undefined;
  }

  const userScope = getUserSkillRoots(input.env);
  const excludedRoots = userScope.excludedRoots
    .map(realpathIfResolvable)
    .filter((entry): entry is string => entry !== undefined);
  const roots = [
    ...(input.inheritance.repo ? [] : getRepoSkillRoots(input.cwd)),
    ...(input.inheritance.user ? [] : userScope.roots),
  ];
  const visitedDirectories = new Set<string>();
  const skillFiles = new Set<string>();
  for (const root of roots) {
    collectSkillFiles(
      root,
      excludedRoots,
      visitedDirectories,
      skillFiles,
      { directories: 0, entries: 0 },
      0,
    );
  }

  const paths = [...skillFiles].sort();
  if (paths.length === 0) {
    return undefined;
  }
  return {
    skills: {
      config: paths.map((path) => ({ path, enabled: false })),
    },
  };
}
