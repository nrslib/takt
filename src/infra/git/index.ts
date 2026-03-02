/**
 * Git provider factory
 *
 * Returns the singleton GitProvider instance.
 */

import { GitHubProvider } from '../github/GitHubProvider.js';
import type { GitProvider } from './types.js';

export type { GitProvider, Issue, CliStatus, ExistingPr, CreatePrOptions, CreatePrResult, CommentResult, CreateIssueOptions, CreateIssueResult, PrReviewComment, PrReviewData } from './types.js';

let provider: GitProvider | undefined;

export function getGitProvider(): GitProvider {
  if (!provider) {
    provider = new GitHubProvider();
  }
  return provider;
}
