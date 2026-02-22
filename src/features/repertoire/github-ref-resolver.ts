/**
 * GitHub ref resolver for repertoire add command.
 *
 * Resolves the ref for a GitHub package installation.
 * When the spec omits @{ref}, queries the GitHub API for the default branch.
 */

/** Injectable function for calling `gh api` (enables unit testing without network). */
export type GhExecFn = (args: string[]) => string;

/**
 * Resolve the ref to use for a GitHub package installation.
 *
 * If specRef is provided, returns it directly. Otherwise calls the GitHub API
 * via execGh to retrieve the repository's default branch.
 *
 * @throws if the API call returns an empty branch name
 */
export function resolveRef(
  specRef: string | undefined,
  owner: string,
  repo: string,
  execGh: GhExecFn,
): string {
  if (specRef !== undefined) {
    return specRef;
  }

  const defaultBranch = execGh([
    'api',
    `/repos/${owner}/${repo}`,
    '--jq', '.default_branch',
  ]).trim();

  if (!defaultBranch) {
    throw new Error(`デフォルトブランチを取得できませんでした: ${owner}/${repo}`);
  }

  return defaultBranch;
}
