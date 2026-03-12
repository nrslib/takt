/**
 * GitLab Issue utilities
 *
 * Fetches issue content via `glab` CLI and formats it for piece execution.
 */

import { execFileSync } from 'node:child_process';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import type { CliStatus, Issue, CreateIssueOptions, CreateIssueResult } from '../git/types.js';

const log = createLogger('gitlab');

/**
 * Check if `glab` CLI is available and authenticated.
 */
export function checkGlabCli(): CliStatus {
  try {
    execFileSync('glab', ['auth', 'status'], { stdio: 'pipe' });
    return { available: true };
  } catch {
    try {
      execFileSync('glab', ['--version'], { stdio: 'pipe' });
      return {
        available: false,
        error: 'glab CLI is installed but not authenticated. Run `glab auth login` first.',
      };
    } catch {
      return {
        available: false,
        error: 'glab CLI is not installed. Install it from https://gitlab.com/gitlab-org/cli',
      };
    }
  }
}

/**
 * Fetch issue content via `glab issue view`.
 * Throws on failure (issue not found, network error, etc.).
 */
export function fetchIssue(issueNumber: number): Issue {
  log.debug('Fetching issue', { issueNumber });

  const raw = execFileSync(
    'glab',
    ['issue', 'view', String(issueNumber), '--output', 'json'],
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );

  let data: {
    iid: number;
    title: string;
    description: string | null;
    labels: string[];
    notes: Array<{ author: { username: string }; body: string }>;
  };
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`glab returned invalid JSON for issue #${issueNumber}`);
  }

  return {
    number: data.iid,
    title: data.title,
    body: data.description ?? '',
    labels: data.labels,
    comments: data.notes.map((n) => ({
      author: n.author.username,
      body: n.body,
    })),
  };
}

/**
 * Create a GitLab Issue via `glab issue create`.
 */
export function createIssue(options: CreateIssueOptions): CreateIssueResult {
  const glabStatus = checkGlabCli();
  if (!glabStatus.available) {
    return { success: false, error: glabStatus.error };
  }

  const args = ['issue', 'create', '--title', options.title, '--description', options.body];
  if (options.labels && options.labels.length > 0) {
    args.push('--label', options.labels.join(','));
  }

  log.info('Creating issue', { title: options.title });

  try {
    const output = execFileSync('glab', args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const url = output.trim();
    log.info('Issue created', { url });

    return { success: true, url };
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    log.error('Issue creation failed', { error: errorMessage });
    return { success: false, error: errorMessage };
  }
}
