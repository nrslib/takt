import { execFileSync } from 'node:child_process';
import { toLocalBranchRef } from '../../shared/utils/gitBranchValidation.js';
import { buildChildProcessEnv } from '../../shared/utils/child-process-env.js';
import { runGitCommandAbortable } from './clone-exec.js';
import { getCloneMetaPath } from './clone-meta.js';
import { lstatIfExists } from '../../shared/utils/pathBoundary.js';
import { isTaskAbortError } from './clone-errors.js';

const GENERATED_BRANCH_QUERY_TIMEOUT_MS = 30_000;

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

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
  const configuredCommand = env.GIT_SSH_COMMAND?.trim() || configuredCoreSshCommand(projectDir, env);
  const sshCommand = configuredCommand
    ? configuredCommand
      .replace(/(^|\s)-o(?:\s+)?["']?BatchMode=(?:yes|no)["']?(?=\s|$)/gi, '$1')
      .replace(/(^|\s)["']-o\s+BatchMode=(?:yes|no)["'](?=\s|$)/gi, '$1')
      .trim() || 'ssh'
    : env.GIT_SSH?.trim() ? quoteShellArgument(env.GIT_SSH) : 'ssh';
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GCM_INTERACTIVE: '0',
    GIT_SSH_COMMAND: `${sshCommand} -o BatchMode=yes`,
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

function candidateBranch(base: string, sequence: number, suffixComponentIndex: number): string {
  if (sequence === 1) return base;
  const components = base.split('/');
  components[suffixComponentIndex] += `-${sequence}`;
  return components.join('/');
}

function branchPrefixes(branch: string): string[] {
  const components = branch.split('/');
  return components.map((_, index) => components.slice(0, index + 1).join('/')).reverse();
}

function remoteQueryRefs(branch: string): string[] {
  const candidate = toLocalBranchRef(branch);
  return [candidate, `${candidate}/*`, ...branchPrefixes(branch).slice(1).map(toLocalBranchRef)];
}

function candidateRefs(branch: string, remotes: string[]): string[] {
  const prefixes = branchPrefixes(branch);
  const namespaces = [
    'refs/heads',
    // Preserve collision checks for cached origin refs even without an origin remote.
    ...[...new Set(['origin', ...remotes])].map((remote) => `refs/remotes/${remote}`),
  ];
  return namespaces.flatMap((namespace) => prefixes.map((prefix) => `${namespace}/${prefix}`));
}

function collidingSegment(refs: string[], branch: string, namespaces: string[]): number | undefined {
  let segment: number | undefined;
  for (const ref of refs) {
    for (const namespace of namespaces) {
      if (!ref.startsWith(`${namespace}/`)) continue;
      const existing = ref.slice(namespace.length + 1);
      const conflict = existing === branch || existing.startsWith(`${branch}/`)
        ? branch.split('/').length - 1
        : branch.startsWith(`${existing}/`) ? existing.split('/').length - 1 : undefined;
      if (conflict !== undefined) segment = Math.min(segment ?? conflict, conflict);
    }
  }
  return segment;
}

function parseRemotes(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

function localCollision(output: string, branch: string, remotes: string[]): number | undefined {
  return collidingSegment(output.trim().split(/\r?\n/), branch, [
    'refs/heads', ...[...new Set(['origin', ...remotes])].map((remote) => `refs/remotes/${remote}`),
  ]);
}

function remoteCollision(output: string, branch: string): number | undefined {
  return collidingSegment(
    output.trim().split(/\r?\n/).map((line) => line.split(/\s+/)[1] ?? ''),
    branch,
    ['refs/heads'],
  );
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
  let suffixComponentIndex = base.split('/').length - 1;
  nextCandidate: for (let sequence = 1; ; sequence++) {
    const branch = candidateBranch(base, sequence, suffixComponentIndex);
    const refs = candidateRefs(branch, remotes);
    const localSegment = localCollision(git(['for-each-ref', '--format=%(refname)', ...refs]), branch, remotes);
    if (localSegment !== undefined) {
      suffixComponentIndex = Math.min(suffixComponentIndex, localSegment);
      continue;
    }
    for (const remote of remotes) {
      let remoteRefs: string;
      try {
        remoteRefs = git(['ls-remote', '--heads', remote, ...remoteQueryRefs(branch)]);
      } catch (error) {
        throw failedRemoteBranchCheck(remote, branch, error);
      }
      const remoteSegment = remoteCollision(remoteRefs, branch);
      if (remoteSegment !== undefined) {
        suffixComponentIndex = Math.min(suffixComponentIndex, remoteSegment);
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
  let suffixComponentIndex = base.split('/').length - 1;
  nextCandidate: for (let sequence = 1; ; sequence++) {
    const branch = candidateBranch(base, sequence, suffixComponentIndex);
    const refs = candidateRefs(branch, remotes);
    const localSegment = localCollision(await git(['for-each-ref', '--format=%(refname)', ...refs]), branch, remotes);
    if (localSegment !== undefined) {
      suffixComponentIndex = Math.min(suffixComponentIndex, localSegment);
      continue;
    }
    for (const remote of remotes) {
      let remoteRefs: string;
      try {
        remoteRefs = await git(['ls-remote', '--heads', remote, ...remoteQueryRefs(branch)]);
      } catch (error) {
        if (isTaskAbortError(error)) {
          throw error;
        }
        throw failedRemoteBranchCheck(remote, branch, error);
      }
      const remoteSegment = remoteCollision(remoteRefs, branch);
      if (remoteSegment !== undefined) {
        suffixComponentIndex = Math.min(suffixComponentIndex, remoteSegment);
        continue nextCandidate;
      }
    }
    if (lstatIfExists(getCloneMetaPath(projectDir, branch, cloneMetadataDirectory)) !== null) {
      continue;
    }
    return branch;
  }
}
