import { ProjectConfigSchema } from '../../../core/models/index.js';
import { formatIssuePath } from '../issuePath.js';

export function assertValidProjectConfig(
  rawConfig: Record<string, unknown>,
  configPath: string,
  onlyUnrecognizedKeys = false,
): void {
  const parsedResult = ProjectConfigSchema.safeParse(rawConfig);
  if (!parsedResult.success) {
    const firstIssue = onlyUnrecognizedKeys
      ? parsedResult.error.issues.find((issue) => issue.code === 'unrecognized_keys')
      : parsedResult.error.issues[0];
    if (!firstIssue) {
      return;
    }
    const issuePath = formatIssuePath(firstIssue.path);
    const issueMessage = firstIssue.message ?? 'Invalid configuration value';
    throw new Error(
      `Configuration error: invalid ${issuePath} in ${configPath}: ${issueMessage}`,
    );
  }
}
