import { isAbsolute, resolve } from 'node:path';
import { runGit } from './branchGitCommands.js';

export type BranchBaseResolutionCache = {
  allCandidateRefsByRepositoryKey: Map<string, string[]>;
  repositoryKeyByGitCwd: Map<string, string>;
};

export function createBranchBaseResolutionCache(): BranchBaseResolutionCache {
  return {
    allCandidateRefsByRepositoryKey: new Map<string, string[]>(),
    repositoryKeyByGitCwd: new Map<string, string>(),
  };
}

function resolveRepositoryKey(gitCwd: string, cache?: BranchBaseResolutionCache): string {
  const cachedKey = cache?.repositoryKeyByGitCwd.get(gitCwd);
  if (cachedKey) {
    return cachedKey;
  }

  const commonDir = runGit(gitCwd, ['rev-parse', '--git-common-dir']);
  const repositoryKey = isAbsolute(commonDir) ? commonDir : resolve(gitCwd, commonDir);
  if (cache) {
    cache.repositoryKeyByGitCwd.set(gitCwd, repositoryKey);
  }
  return repositoryKey;
}

function listAllCandidateRefs(gitCwd: string, cache?: BranchBaseResolutionCache): string[] {
  const repositoryKey = resolveRepositoryKey(gitCwd, cache);
  const cachedRefs = cache?.allCandidateRefsByRepositoryKey.get(repositoryKey);
  if (cachedRefs) {
    return cachedRefs;
  }

  const output = runGit(gitCwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']);
  const refs = output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(ref => !ref.endsWith('/HEAD'));

  const distinctRefs = Array.from(new Set(refs));
  if (cache) {
    cache.allCandidateRefsByRepositoryKey.set(repositoryKey, distinctRefs);
  }

  return distinctRefs;
}

export function listCandidateRefs(gitCwd: string, branch: string, cache?: BranchBaseResolutionCache): string[] {
  return listAllCandidateRefs(gitCwd, cache)
    .filter(ref => ref !== branch)
    .filter(ref => !ref.endsWith(`/${branch}`));
}
