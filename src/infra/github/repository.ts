import { execFileSync } from 'node:child_process';

interface GhRepoViewResponse {
  nameWithOwner: string;
}

export function resolveRepositoryNameWithOwner(cwd: string): string {
  const output = execFileSync(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner'],
    { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const repo = JSON.parse(output) as GhRepoViewResponse;
  if (!repo.nameWithOwner) {
    throw new Error('gh repo view did not return nameWithOwner');
  }
  return repo.nameWithOwner;
}
