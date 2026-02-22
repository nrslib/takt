/**
 * GitHub package spec parser for repertoire add command.
 *
 * Parses "github:{owner}/{repo}@{ref}" format into structured components.
 * The @{ref} part is optional; when omitted, ref is undefined and the caller
 * should resolve the default branch via the GitHub API.
 */

export interface GithubPackageRef {
  owner: string;
  repo: string;
  /** The ref (branch, tag, or SHA) to install. `undefined` when omitted from the spec. */
  ref: string | undefined;
}

/**
 * Parse a GitHub package spec string into its components.
 *
 * @param spec - e.g. "github:nrslib/takt-fullstack@main" or "github:nrslib/takt-fullstack"
 * @returns Parsed owner, repo, and ref (owner and repo are lowercased; ref may be undefined)
 * @throws if the spec format is invalid
 */
export function parseGithubSpec(spec: string): GithubPackageRef {
  if (!spec.startsWith('github:')) {
    throw new Error(`Invalid package spec: "${spec}". Expected "github:{owner}/{repo}@{ref}"`);
  }
  const withoutPrefix = spec.slice('github:'.length);
  const atIdx = withoutPrefix.lastIndexOf('@');

  let ownerRepo: string;
  let ref: string | undefined;

  if (atIdx < 0) {
    ownerRepo = withoutPrefix;
    ref = undefined;
  } else {
    ownerRepo = withoutPrefix.slice(0, atIdx);
    ref = withoutPrefix.slice(atIdx + 1);
  }

  const slashIdx = ownerRepo.indexOf('/');
  if (slashIdx < 0) {
    throw new Error(`Invalid package spec: "${spec}". Missing repo name`);
  }
  const owner = ownerRepo.slice(0, slashIdx).toLowerCase();
  const repo = ownerRepo.slice(slashIdx + 1).toLowerCase();
  return { owner, repo, ref };
}
