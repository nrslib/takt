/**
 * GitLab Merge Request utilities
 *
 * Creates and manages MRs via `glab` CLI.
 */

import { execFileSync } from 'node:child_process';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { checkGlabCli, fetchAllPages, parseJson, ITEMS_PER_PAGE } from './utils.js';
import type { CreatePrOptions, CreatePrResult, ExistingPr, CommentResult, PrReviewData, PrReviewComment } from '../git/types.js';

const log = createLogger('gitlab-mr');

/**
 * Find an open MR for the given branch.
 * Returns undefined if no MR exists.
 */
export function findExistingMr(branch: string, cwd: string): ExistingPr | undefined {
  const glabStatus = checkGlabCli(cwd);
  if (!glabStatus.available) return undefined;

  try {
    const output = execFileSync(
      'glab',
      ['mr', 'list', '--source-branch', branch, '--state', 'opened', '--output', 'json'],
      { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const mrs = parseJson<Array<{ iid: number; web_url: string }>>(output, 'mr list');
    const first = mrs[0];
    if (!first) return undefined;
    return { number: first.iid, url: first.web_url };
  } catch (e) {
    log.debug('glab mr list failed, treating as no MR', { error: getErrorMessage(e) });
    return undefined;
  }
}

/**
 * Create a GitLab Merge Request via `glab mr create`.
 */
export function createMergeRequest(options: CreatePrOptions, cwd: string): CreatePrResult {
  if (options.repo) {
    throw new Error('--repo is not supported with GitLab provider. Use cwd context instead.');
  }

  const glabStatus = checkGlabCli(cwd);
  if (!glabStatus.available) {
    return { success: false, error: glabStatus.error };
  }

  const args = [
    'mr', 'create',
    '--title', options.title,
    '--description', options.body,
    '--source-branch', options.branch,
  ];

  if (options.base) {
    args.push('--target-branch', options.base);
  }

  if (options.draft) {
    args.push('--draft');
  }

  log.info('Creating MR', { branch: options.branch, title: options.title, draft: options.draft });

  try {
    const output = execFileSync('glab', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const url = output.trim();
    log.info('MR created', { url });

    return { success: true, url };
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    log.error('MR creation failed', { error: errorMessage });
    return { success: false, error: errorMessage };
  }
}

/**
 * Add a comment (note) to a GitLab Merge Request.
 */
export function commentOnMr(mrNumber: number, body: string, cwd: string): CommentResult {
  const glabStatus = checkGlabCli(cwd);
  if (!glabStatus.available) {
    return { success: false, error: glabStatus.error };
  }

  try {
    execFileSync('glab', ['mr', 'note', String(mrNumber), '--message', body], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true };
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    log.error('MR comment failed', { error: errorMessage });
    return { success: false, error: errorMessage };
  }
}

/** Raw shape returned by `glab mr view --output json` */
interface GlabMrViewResponse {
  iid: number;
  title: string;
  description: string | null;
  web_url: string;
  source_branch: string;
  target_branch: string;
}

/** Raw note from GitLab Notes API */
interface GlabNote {
  body: string;
  author: { username: string };
  system: boolean;
  position?: unknown;
}

/** Raw discussion from GitLab Discussions API */
interface GlabDiscussion {
  notes: Array<{
    body: string;
    author: { username: string };
    system: boolean;
    position?: {
      new_path: string;
      new_line: number;
    };
  }>;
}

/**
 * Fetch MR review comments and metadata.
 * Uses `glab mr view` for metadata and `glab api` (paginated) for diffs, notes, and discussions.
 *
 * Throws on failure (MR not found, network error, etc.).
 */
export function fetchMrReviewComments(mrNumber: number, cwd: string): PrReviewData {
  log.debug('Fetching MR review comments', { mrNumber });

  const rawMr = execFileSync(
    'glab',
    ['mr', 'view', String(mrNumber), '--output', 'json'],
    { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const mrData = parseJson<GlabMrViewResponse>(rawMr, `mr view #${mrNumber}`);

  const diffs = fetchAllPages<{ new_path: string }>(
    `projects/:id/merge_requests/${mrNumber}/diffs`,
    ITEMS_PER_PAGE,
    `mr #${mrNumber} diffs`,
    cwd,
  );
  const files = diffs.map(d => d.new_path);

  const allNotes = fetchAllPages<GlabNote>(
    `projects/:id/merge_requests/${mrNumber}/notes`,
    ITEMS_PER_PAGE,
    `mr #${mrNumber} notes`,
    cwd,
  );

  const comments: PrReviewComment[] = [];
  for (const note of allNotes) {
    if (!note.system && !note.position) {
      comments.push({ author: note.author.username, body: note.body });
    }
  }

  const allDiscussions = fetchAllPages<GlabDiscussion>(
    `projects/:id/merge_requests/${mrNumber}/discussions`,
    ITEMS_PER_PAGE,
    `mr #${mrNumber} discussions`,
    cwd,
  );

  const reviews: PrReviewComment[] = [];
  for (const discussion of allDiscussions) {
    for (const note of discussion.notes) {
      if (note.position) {
        reviews.push({
          author: note.author.username,
          body: note.body,
          path: note.position.new_path,
          line: note.position.new_line,
        });
      }
    }
  }

  return {
    number: mrData.iid,
    title: mrData.title,
    body: mrData.description ?? '',
    url: mrData.web_url,
    headRefName: mrData.source_branch,
    baseRefName: mrData.target_branch,
    comments,
    reviews,
    files,
  };
}
