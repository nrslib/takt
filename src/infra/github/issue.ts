/**
 * GitHub Issue utilities
 */

import { execFileSync } from 'node:child_process';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import type { CliStatus, Issue, CreateIssueOptions, CreateIssueResult } from '../git/types.js';

const log = createLogger('github');

/**
 * Check if `gh` CLI is available and authenticated.
 */
export function checkGhCli(cwd: string): CliStatus {
  try {
    execFileSync('gh', ['auth', 'status'], { cwd, stdio: 'pipe' });
    return { available: true };
  } catch {
    try {
      execFileSync('gh', ['--version'], { cwd, stdio: 'pipe' });
      return {
        available: false,
        error: 'gh CLI is installed but not authenticated. Run `gh auth login` first.',
      };
    } catch {
      return {
        available: false,
        error: 'gh CLI is not installed. Install it from https://cli.github.com/',
      };
    }
  }
}

/**
 * Fetch issue content via `gh issue view`.
 * Throws on failure (issue not found, network error, etc.).
 */
export function fetchIssue(issueNumber: number, cwd: string): Issue {
  log.debug('Fetching issue', { issueNumber });

  const raw = execFileSync(
    'gh',
    ['issue', 'view', String(issueNumber), '--json', 'number,title,body,labels,comments'],
    { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const data = JSON.parse(raw) as {
    number: number;
    title: string;
    body: string;
    labels: Array<{ name: string }>;
    comments: Array<{ author: { login: string }; body: string }>;
  };

  return {
    number: data.number,
    title: data.title,
    body: data.body ?? '',
    labels: data.labels.map((l) => l.name),
    comments: data.comments.map((c) => ({
      author: c.author.login,
      body: c.body,
    })),
  };
}

/**
 * Filter labels to only those that exist on the repository.
 */
function filterExistingLabels(labels: string[], cwd: string): string[] {
  try {
    const existing = new Set(
      execFileSync('gh', ['label', 'list', '--json', 'name', '-q', '.[].name'], {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
        .trim()
        .split('\n')
        .filter((l) => l.length > 0),
    );
    return labels.filter((l) => existing.has(l));
  } catch (err) {
    log.error('Failed to fetch labels', { error: getErrorMessage(err) });
    return [];
  }
}

/**
 * Create a GitHub Issue via `gh issue create`.
 */
export function createIssue(options: CreateIssueOptions, cwd: string): CreateIssueResult {
  const ghStatus = checkGhCli(cwd);
  if (!ghStatus.available) {
    return { success: false, error: ghStatus.error };
  }

  const args = ['issue', 'create', '--title', options.title, '--body', options.body];
  if (options.labels && options.labels.length > 0) {
    const validLabels = filterExistingLabels(options.labels, cwd);
    if (validLabels.length > 0) {
      args.push('--label', validLabels.join(','));
    }
  }

  log.info('Creating issue', { title: options.title });

  try {
    const output = execFileSync('gh', args, {
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
