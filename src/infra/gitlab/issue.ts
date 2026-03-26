/**
 * GitLab Issue utilities
 *
 * Fetches issue content via `glab` CLI and formats it for piece execution.
 */

import { execFileSync } from 'node:child_process';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import type { Issue, CreateIssueOptions, CreateIssueResult } from '../git/types.js';
import { checkGlabCli, fetchAllPages, parseJson, ITEMS_PER_PAGE } from './utils.js';

const log = createLogger('gitlab');

/** Raw note from GitLab Notes API */
interface GlabIssueNote {
  body: string;
  author: { username: string };
  system: boolean;
}

/**
 * Fetch issue content via `glab issue view` + separate notes API call.
 *
 * Notes are fetched via `glab api` with pagination because
 * `glab issue view --output json` does not include notes.
 *
 * Throws on failure (issue not found, network error, etc.).
 */
export function fetchIssue(issueNumber: number, cwd: string): Issue {
  log.debug('Fetching issue', { issueNumber });

  const raw = execFileSync(
    'glab',
    ['issue', 'view', String(issueNumber), '--output', 'json'],
    { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const data = parseJson<{
    iid: number;
    title: string;
    description: string | null;
    labels: string[];
  }>(raw, `issue view #${issueNumber}`);

  const allNotes = fetchAllPages<GlabIssueNote>(
    `projects/:id/issues/${issueNumber}/notes`,
    ITEMS_PER_PAGE,
    `issue #${issueNumber} notes`,
    cwd,
  );

  return {
    number: data.iid,
    title: data.title,
    body: data.description ?? '',
    labels: data.labels,
    comments: allNotes
      .filter((n) => !n.system)
      .map((n) => ({
        author: n.author.username,
        body: n.body,
      })),
  };
}

/**
 * Create a GitLab Issue via `glab issue create`.
 */
export function createIssue(options: CreateIssueOptions, cwd: string): CreateIssueResult {
  const glabStatus = checkGlabCli(cwd);
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
      cwd,
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
