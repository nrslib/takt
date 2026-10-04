/**
 * GitLab Issue utilities
 *
 * Fetches issue content via `glab` CLI and formats it for workflow execution.
 */

import { execFileSync } from 'node:child_process';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { getIssueCommentFailureReason } from '../git/issue-comment-error.js';
import type {
  CloseIssueResult,
  CreateIssueOptions,
  CreateIssueResult,
  Issue,
  IssueCommentResult,
  IssueListItem,
} from '../git/types.js';
import { normalizePublicIssueUrl } from '../git/types.js';
import { parseIssueNumberFromUrl } from '../git/format.js';
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

export function commentOnIssue(issueNumber: number, body: string, cwd: string): IssueCommentResult {
  const glabStatus = checkGlabCli(cwd);
  if (!glabStatus.available) {
    return { success: false, error: glabStatus.error };
  }

  try {
    execFileSync(
      'glab',
      [
        'api',
        `projects/:id/issues/${issueNumber}/notes`,
        '--method',
        'POST',
        '--field',
        'body=@-',
      ],
      {
        cwd,
        encoding: 'utf-8',
        input: body,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    return { success: true };
  } catch (err) {
    const errorMessage = getIssueCommentFailureReason(err, body);
    log.error('Issue comment failed', { issueNumber, error: errorMessage });
    return { success: false, error: errorMessage };
  }
}

interface GlabOpenIssueItem {
  iid: number;
  title: string;
  labels: string[];
  updated_at: string;
}

export function listOpenIssues(cwd: string): IssueListItem[] {
  const issues = fetchAllPages<GlabOpenIssueItem>(
    'projects/:id/issues?state=opened',
    ITEMS_PER_PAGE,
    'open issue list',
    cwd,
  );

  return issues.map((issue) => ({
    number: issue.iid,
    title: issue.title,
    labels: issue.labels,
    updated_at: issue.updated_at,
  }));
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

  let output: string;
  try {
    output = execFileSync('glab', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    log.error('Issue creation failed', { error: errorMessage });
    return { success: false, error: errorMessage };
  }

  const url = output.trim();
  const publicUrl = normalizePublicIssueUrl(url);
  try {
    const issueNumber = parseIssueNumberFromUrl(url);
    log.info('Issue created', { url: publicUrl, issueNumber });
    return {
      success: true,
      issueNumber,
      ...(publicUrl !== undefined ? { url: publicUrl } : {}),
    };
  } catch {
    const errorMessage = 'Failed to extract issue number from created issue URL';
    log.error('Issue number extraction failed after issue creation', {
      error: errorMessage,
      ...(publicUrl !== undefined ? { url: publicUrl } : {}),
    });
    return {
      success: false,
      issueCreated: true,
      ...(publicUrl !== undefined ? { url: publicUrl } : {}),
      error: errorMessage,
    };
  }
}

export function closeIssue(issueNumber: number, comment: string, cwd: string): CloseIssueResult {
  const glabStatus = checkGlabCli(cwd);
  if (!glabStatus.available) {
    return { success: false, error: glabStatus.error };
  }

  let commentCreated = false;
  try {
    execFileSync('glab', ['issue', 'note', String(issueNumber), '--message', comment], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    commentCreated = true;
    execFileSync('glab', ['issue', 'close', String(issueNumber)], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, commentCreated };
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    log.error('Issue close failed', { issueNumber, commentCreated, error: errorMessage });
    return { success: false, commentCreated, error: errorMessage };
  }
}
