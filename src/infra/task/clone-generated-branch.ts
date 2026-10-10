import { execFileSync } from 'node:child_process';
import { toLocalBranchRef } from '../../shared/utils/gitBranchValidation.js';
import { runGitCommandAbortable } from './clone-exec.js';
import { getCloneMetaPath } from './clone-meta.js';
import { lstatIfExists } from '../../shared/utils/pathBoundary.js';

function candidateBranch(base: string, sequence: number): string {
  return sequence === 1 ? base : `${base}-${sequence}`;
}

function candidateRefs(branch: string, remotes: string[]): string[] {
  return [
    toLocalBranchRef(branch),
    // Preserve collision checks for cached origin refs even without an origin remote.
    ...[...new Set(['origin', ...remotes])].map((remote) => `refs/remotes/${remote}/${branch}`),
  ];
}

function hasCandidateRef(output: string, candidates: string[]): boolean {
  const refs = output.trim().split(/\r?\n/);
  return candidates.some((ref) => refs.includes(ref));
}

function parseRemotes(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

function hasRemoteCandidate(output: string, branch: string): boolean {
  return output.trim().split(/\r?\n/).some((line) => line.split(/\s+/)[1] === toLocalBranchRef(branch));
}

export function resolveGeneratedBranch(projectDir: string, base: string, cloneMetadataDirectory?: string): string {
  const git = (args: string[]): string => execFileSync('git', args, {
    cwd: projectDir, encoding: 'utf-8', stdio: 'pipe',
  }).toString();
  const remotes = parseRemotes(git(['remote']));
  nextCandidate: for (let sequence = 1; ; sequence++) {
    const branch = candidateBranch(base, sequence);
    const refs = candidateRefs(branch, remotes);
    if (hasCandidateRef(git(['for-each-ref', '--format=%(refname)', ...refs]), refs)) {
      continue;
    }
    for (const remote of remotes) {
      if (hasRemoteCandidate(git(['ls-remote', '--heads', remote, toLocalBranchRef(branch)]), branch)) {
        continue nextCandidate;
      }
    }
    if (lstatIfExists(getCloneMetaPath(projectDir, branch, cloneMetadataDirectory)) !== null) {
      continue;
    }
    return branch;
  }
}

export async function resolveGeneratedBranchAbortable(
  projectDir: string,
  base: string,
  abortSignal?: AbortSignal,
  cloneMetadataDirectory?: string,
): Promise<string> {
  const git = async (args: string[]): Promise<string> => {
    const { stdout } = await runGitCommandAbortable(projectDir, args, abortSignal);
    return stdout;
  };
  const remotes = parseRemotes(await git(['remote']));
  nextCandidate: for (let sequence = 1; ; sequence++) {
    const branch = candidateBranch(base, sequence);
    const refs = candidateRefs(branch, remotes);
    if (hasCandidateRef(await git(['for-each-ref', '--format=%(refname)', ...refs]), refs)) {
      continue;
    }
    for (const remote of remotes) {
      if (hasRemoteCandidate(await git(['ls-remote', '--heads', remote, toLocalBranchRef(branch)]), branch)) {
        continue nextCandidate;
      }
    }
    if (lstatIfExists(getCloneMetaPath(projectDir, branch, cloneMetadataDirectory)) !== null) {
      continue;
    }
    return branch;
  }
}
