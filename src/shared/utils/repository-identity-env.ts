/**
 * Repository identity variables carried in `childProcessEnv` next to the
 * nested observability snapshot. They name the repository for `gh` / `glab`
 * in a clone without git remotes; none of them is a credential.
 */
export const REPOSITORY_IDENTITY_ENV_KEYS = ['GH_REPO', 'GITLAB_REPO'] as const;

const REPOSITORY_IDENTITY_ENV_KEY_SET = new Set<string>(REPOSITORY_IDENTITY_ENV_KEYS);

export function isRepositoryIdentityEnvKey(key: string): boolean {
  return REPOSITORY_IDENTITY_ENV_KEY_SET.has(key);
}

export function pickRepositoryIdentityEnv(
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (!childProcessEnv) return env;
  for (const key of REPOSITORY_IDENTITY_ENV_KEYS) {
    const value = childProcessEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function omitRepositoryIdentityEnv(
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!childProcessEnv) return childProcessEnv;
  const entries = Object.entries(childProcessEnv).filter(([key]) => !isRepositoryIdentityEnvKey(key));
  return entries.length === Object.keys(childProcessEnv).length
    ? childProcessEnv
    : entries.length === 0 ? undefined : Object.fromEntries(entries);
}
