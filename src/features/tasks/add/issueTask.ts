import { info, success, error } from '../../../shared/ui/index.js';
import { getGitProvider } from '../../../infra/git/index.js';
import { createLogger } from '../../../shared/utils/index.js';

const TITLE_MAX_LENGTH = 100;
const TITLE_TRUNCATE_LENGTH = 97;
const MIN_TITLE_LENGTH = 4;
const MARKDOWN_HEADING_PATTERN = /^#{1,3}\s+\S/;
const MARKDOWN_TITLE_DECORATION_PREFIX_PATTERN =
  /^(?:(?:#{1,6}\s+)|(?:[-*+]\s+\[[ xX]\]\s+)|(?:[-*+]\s+))+/;
const PROHIBITED_TITLE_PATTERNS: readonly RegExp[] = [
  /^#{1,6}\s*タスク指示書\s*$/,
  /^タスク指示書\s*$/i,
  /^#{1,6}\s*Task\s+(Order|Spec(?:ification)?)\s*$/i,
  /^Task\s+(Order|Spec(?:ification)?)\s*$/i,
  /^(Summary|Goals|Acceptance Criteria)$/i,
  /^(概要|目的|受け入れ条件)$/,
];

type StructuredTitleFallbackReason = 'missing' | 'too_short' | 'prohibited_title' | 'unknown';

const log = createLogger('add-task');

function truncateTitle(title: string): string {
  return title.length > TITLE_MAX_LENGTH
    ? `${title.slice(0, TITLE_TRUNCATE_LENGTH)}...`
    : title;
}

function normalizeTitleCandidate(title: string): string {
  return title
    .trim()
    .replace(MARKDOWN_TITLE_DECORATION_PREFIX_PATTERN, '')
    .trim();
}

function isProhibitedTitle(title: string): boolean {
  const normalized = normalizeTitleCandidate(title);
  return PROHIBITED_TITLE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isValidGeneratedTitle(title: string): boolean {
  const normalized = normalizeTitleCandidate(title);
  return normalized.length >= MIN_TITLE_LENGTH && !isProhibitedTitle(normalized);
}

/**
 * 呼び出し前提: caller は `title === undefined` または `isValidGeneratedTitle(title) === false`
 * のいずれかを保証する。前提を満たす入力に対し、最後の `return 'unknown'` には到達しない。
 *
 * `'unknown'` は前提違反検出用のセンチネル値。throw せず返す理由は、本関数の呼び出し元
 * (resolveIssueTitle / createIssueFromTask の catch ブロック) がいずれもログ用途であり、
 * 例外を上位伝播させると issue 作成失敗のログ出力という本来の責務が果たせなくなるため。
 * `fallback_reason` メトリクスで `'unknown'` を観測したら、本関数の呼び出し前提が崩れた
 * シグナルとして調査する。
 */
function getStructuredTitleFallbackReason(title: string | undefined): StructuredTitleFallbackReason {
  if (title === undefined) {
    return 'missing';
  }
  const normalized = normalizeTitleCandidate(title);
  if (normalized.length === 0) {
    return 'missing';
  }
  if (isProhibitedTitle(normalized)) {
    return 'prohibited_title';
  }
  if (normalized.length < MIN_TITLE_LENGTH) {
    return 'too_short';
  }
  return 'unknown';
}

function buildTitleCandidates(lines: string[]): string[] {
  const headings = lines
    .filter((line) => MARKDOWN_HEADING_PATTERN.test(line))
    .map(normalizeTitleCandidate);
  const plainLines = lines
    .filter((line) => line.trim().length > 0 && !MARKDOWN_HEADING_PATTERN.test(line))
    .map(normalizeTitleCandidate);
  return [...headings, ...plainLines].filter((candidate) => candidate.length > 0);
}

function resolveTaskDerivedIssueTitle(task: string): string | undefined {
  const lines = task.split('\n');
  const candidates = buildTitleCandidates(lines);
  const validCandidate = candidates.find((candidate) => isValidGeneratedTitle(candidate));
  return validCandidate ? truncateTitle(validCandidate) : undefined;
}

export function extractTitle(task: string): string {
  const title = resolveTaskDerivedIssueTitle(task);
  if (title === undefined) {
    throw new Error('No valid issue title could be generated from task content');
  }
  return title;
}

function resolveIssueTitle(
  task: string,
  structuredTitle: string | undefined,
): { title: string; usedStructuredOutput: boolean; fallbackReason?: StructuredTitleFallbackReason } {
  if (structuredTitle !== undefined && isValidGeneratedTitle(structuredTitle)) {
    return { title: truncateTitle(normalizeTitleCandidate(structuredTitle)), usedStructuredOutput: true };
  }
  const derivedTitle = resolveTaskDerivedIssueTitle(task);
  if (derivedTitle === undefined) {
    throw new Error('No valid issue title could be generated from task content');
  }
  return {
    title: derivedTitle,
    usedStructuredOutput: false,
    fallbackReason: getStructuredTitleFallbackReason(structuredTitle),
  };
}

export function createIssueFromTask(
  task: string,
  options?: { labels?: string[]; cwd?: string; title?: string },
): number | undefined {
  info('Creating issue...');
  let resolvedTitle: ReturnType<typeof resolveIssueTitle>;
  try {
    resolvedTitle = resolveIssueTitle(task, options?.title);
  } catch (titleError) {
    const message = titleError instanceof Error ? titleError.message : String(titleError);
    error(`Failed to create issue: ${message}`);
    log.error('Failed to create issue', {
      error: message,
      used_structured_output: false,
      fallback_reason: getStructuredTitleFallbackReason(options?.title),
    });
    return undefined;
  }
  const { title, usedStructuredOutput, fallbackReason } = resolvedTitle;
  const effectiveLabels = options?.labels?.filter((l) => l.length > 0) ?? [];
  const labels = effectiveLabels.length > 0 ? effectiveLabels : undefined;

  const issueResult = getGitProvider().createIssue({ title, body: task, labels }, options?.cwd);
  if (issueResult.success) {
    if (!issueResult.url) {
      error('Failed to extract issue number from URL');
      log.error('Failed to create issue', {
        error: 'Failed to extract issue number from URL',
        used_structured_output: usedStructuredOutput,
        ...(fallbackReason !== undefined ? { fallback_reason: fallbackReason } : {}),
      });
      return undefined;
    }
    success(`Issue created: ${issueResult.url}`);
    const num = Number(issueResult.url.split('/').pop());
    if (Number.isNaN(num)) {
      error('Failed to extract issue number from URL');
      log.error('Failed to create issue', {
        error: 'Failed to extract issue number from URL',
        used_structured_output: usedStructuredOutput,
        ...(fallbackReason !== undefined ? { fallback_reason: fallbackReason } : {}),
      });
      return undefined;
    }
    log.info('Issue created', {
      url: issueResult.url,
      issueNumber: num,
      used_structured_output: usedStructuredOutput,
      ...(fallbackReason !== undefined ? { fallback_reason: fallbackReason } : {}),
    });
    return num;
  } else {
    error(`Failed to create issue: ${issueResult.error}`);
    log.error('Failed to create issue', {
      error: issueResult.error,
      used_structured_output: usedStructuredOutput,
      ...(fallbackReason !== undefined ? { fallback_reason: fallbackReason } : {}),
    });
    return undefined;
  }
}
