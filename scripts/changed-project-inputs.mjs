import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolveNpmInvocation } from './npm-invocation.mjs';

export const packageManifestPath = 'package.json';

export function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

export function changedPathsAgainst(head, paths) {
  const tracked = git('diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', head, '--', ...paths);
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z', '--', ...paths);
  return new Set([...tracked.split('\0'), ...untracked.split('\0')].filter(Boolean));
}

export function readInput(file) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat !== undefined && !stat.isFile()) {
    throw new Error(`Expected a regular check input: ${file}`);
  }
  return stat === undefined ? undefined : readFileSync(file);
}

export function readPackageManifests(head, worktreeContent) {
  const hasBaseline = git('ls-tree', '--name-only', head, '--', packageManifestPath) !== '';
  const baseline = hasBaseline ? JSON.parse(git('show', `${head}:${packageManifestPath}`)) : {};
  const worktree = worktreeContent === undefined ? {} : JSON.parse(worktreeContent);
  return { baseline, worktree };
}

export function findChangedNpmScripts({ baseline, worktree }, isRelevant) {
  const previous = baseline.scripts ?? {};
  const current = worktree.scripts ?? {};
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter((name) => isRelevant(name) && previous[name] !== current[name])
    .sort();
}

export function runProjectNpm(args) {
  const npm = resolveNpmInvocation(process.execPath, process.env.npm_execpath);
  const result = spawnSync(npm.executable, [...npm.args, ...args], { stdio: 'inherit' });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}
