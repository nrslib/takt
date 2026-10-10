import { execFileSync } from 'node:child_process';
import { toLocalBranchRef } from '../../shared/utils/gitBranchValidation.js';
import { buildChildProcessEnv } from '../../shared/utils/child-process-env.js';
import { runGitCommandAbortable } from './clone-exec.js';
import { getCloneMetaPath } from './clone-meta.js';
import { lstatIfExists } from '../../shared/utils/pathBoundary.js';
import { isTaskAbortError } from './clone-errors.js';

const GENERATED_BRANCH_QUERY_TIMEOUT_MS = 30_000;

function configuredCoreSshCommand(projectDir: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const output = execFileSync('git', ['config', '--get', 'core.sshCommand'], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: GENERATED_BRANCH_QUERY_TIMEOUT_MS,
      env,
    }).toString().trim();
    return output || undefined;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 1) {
      return undefined;
    }
    throw error;
  }
}

function generatedBranchGitEnv(projectDir: string): NodeJS.ProcessEnv {
  const env = buildChildProcessEnv();
  const sshCommand = env.GIT_SSH_COMMAND?.trim()
    || configuredCoreSshCommand(projectDir, env)
    || env.GIT_SSH?.trim()
    || 'ssh';
  const sshCommandWithoutBatchMode = sshCommand
    .replace(/(^|\s)-o(?:\s+)?["']?BatchMode=(?:yes|no)["']?(?=\s|$)/gi, '$1')
    .replace(/(^|\s)["']-o\s+BatchMode=(?:yes|no)["'](?=\s|$)/gi, '$1')
    .trim();
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GCM_INTERACTIVE: '0',
    GIT_SSH_COMMAND: `${sshCommandWithoutBatchMode || 'ssh'} -o BatchMode=yes`,
  };
}

function failedRemoteBranchCheck(remote: string, branch: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `Failed to check generated branch "${branch}" on remote "${remote}" (${detail}). `
      + 'Refusing to choose a branch because remote collisions could not be checked. '
      + 'Check remote connectivity and credentials, then retry.',
    { cause: error },
  );
}

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
  const env = generatedBranchGitEnv(projectDir);
  const git = (args: string[]): string => execFileSync('git', args, {
    cwd: projectDir,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: GENERATED_BRANCH_QUERY_TIMEOUT_MS,
    env,
  }).toString();
  const remotes = parseRemotes(git(['remote']));
  nextCandidate: for (let sequence = 1; ; sequence++) {
    const branch = candidateBranch(base, sequence);
    const refs = candidateRefs(branch, remotes);
    if (hasCandidateRef(git(['for-each-ref', '--format=%(refname)', ...refs]), refs)) {
      continue;
    }
    for (const remote of remotes) {
      let remoteRefs: string;
      try {
        remoteRefs = git(['ls-remote', '--heads', remote, toLocalBranchRef(branch)]);
      } catch (error) {
        throw failedRemoteBranchCheck(remote, branch, error);
      }
      if (hasRemoteCandidate(remoteRefs, branch)) {
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
  const env = generatedBranchGitEnv(projectDir);
  const git = async (args: string[]): Promise<string> => {
    const { stdout } = await runGitCommandAbortable(
      projectDir,
      args,
      abortSignal,
      env,
      GENERATED_BRANCH_QUERY_TIMEOUT_MS,
    );
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
      let remoteRefs: string;
      try {
        remoteRefs = await git(['ls-remote', '--heads', remote, toLocalBranchRef(branch)]);
      } catch (error) {
        if (isTaskAbortError(error)) {
          throw error;
        }
        throw failedRemoteBranchCheck(remote, branch, error);
      }
      if (hasRemoteCandidate(remoteRefs, branch)) {
        continue nextCandidate;
      }
    }
    if (lstatIfExists(getCloneMetaPath(projectDir, branch, cloneMetadataDirectory)) !== null) {
      continue;
    }
    return branch;
  }
}
