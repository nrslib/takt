export interface GitHubPullRequestTarget {
  readonly hostname: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly url: string;
}

export function parseGitHubPullRequestTarget(value: string): GitHubPullRequestTarget {
  const url = new URL(value);
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/u.exec(url.pathname);
  const number = Number(match?.[3]);
  if (url.protocol !== 'https:' || url.username || url.password || match === null
    || !Number.isSafeInteger(number) || number < 1) {
    throw new Error('Invalid GitHub pull request URL');
  }
  const owner = match[1]!;
  const repo = match[2]!;
  return { hostname: url.hostname, owner, repo, number,
    url: `${url.origin}/${owner}/${repo}/pull/${number}` };
}

export function assertGitHubPullRequestTarget(value: string, target: GitHubPullRequestTarget): void {
  const actual = parseGitHubPullRequestTarget(value);
  if (actual.hostname !== target.hostname || actual.owner.toLowerCase() !== target.owner.toLowerCase()
    || actual.repo.toLowerCase() !== target.repo.toLowerCase() || actual.number !== target.number) {
    throw new Error('GitHub returned a different pull request than the published target');
  }
}

export function resolvePublishedPrRepositoryUrl(
  originUrl: string, repositorySshUrl: string, target: GitHubPullRequestTarget,
): string {
  const repositoryMatch = /^git@([^:\s/]+):([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\.git$/u.exec(repositorySshUrl);
  if (!repositoryMatch?.[2] || repositoryMatch[1]?.toLowerCase() !== target.hostname
    || repositoryMatch[2].endsWith('/.') || repositoryMatch[2].endsWith('/..')) {
    throw new Error(`Invalid published pull request repository for #${target.number}`);
  }
  const repository = repositoryMatch[2];
  const originMatch = /^(git@([^:\s/]+):|(?:https|ssh):\/\/[^\s/?#]+\/)([^\s/?#]+\/[^\s/?#]+)\/?$/u.exec(originUrl);
  if (originMatch?.[1] && originMatch[3]) {
    const originHost = originMatch[2]?.toLowerCase() ?? new URL(originUrl).hostname;
    if (originHost === target.hostname) {
      if (originMatch[3].replace(/\.git$/iu, '').toLowerCase() === repository.toLowerCase()) return originUrl;
      return `${originMatch[1]}${repository}.git`;
    }
  }
  // A source checkout on another host cannot supply credentials for this PR.
  return repositorySshUrl;
}
