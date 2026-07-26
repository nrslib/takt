import { info, success, error } from '../../shared/ui/index.js';
import { getGitProvider, type CreateIssueResult, type GitProvider } from '../git/index.js';
import { normalizePublicIssueUrl } from '../git/types.js';
import { createLogger } from '../../shared/utils/index.js';
import { safeExternalErrorMessage } from '../../shared/utils/safeExternalErrorMessage.js';

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

type StructuredTitleFallbackReason = 'missing' | 'too_short' | 'prohibited_title';

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
  throw new Error('Structured title fallback reason was requested for a valid title');
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
  generatedTitle: string | undefined,
  explicitTitle: string | undefined,
): { title: string; usedStructuredOutput: boolean; fallbackReason?: StructuredTitleFallbackReason } {
  if (explicitTitle !== undefined) {
    return { title: explicitTitle, usedStructuredOutput: true };
  }
  if (generatedTitle !== undefined && isValidGeneratedTitle(generatedTitle)) {
    return { title: truncateTitle(normalizeTitleCandidate(generatedTitle)), usedStructuredOutput: true };
  }
  const derivedTitle = resolveTaskDerivedIssueTitle(task);
  if (derivedTitle === undefined) {
    throw new Error('No valid issue title could be generated from task content');
  }
  return {
    title: derivedTitle,
    usedStructuredOutput: false,
    fallbackReason: getStructuredTitleFallbackReason(generatedTitle),
  };
}

type CreateIssueFromTaskOptions = {
  labels?: string[];
  cwd?: string;
  title?: string;
  explicitTitle?: string;
  outputMode?: 'terminal' | 'silent';
  gitProvider?: Pick<GitProvider, 'createIssue'>;
};

export type CreateIssueFromTaskResult =
  | { success: true; issueNumber: number; issueUrl?: string }
  | { success: false; issueCreated: true; issueUrl?: string; error: string }
  | { success: false; issueCreated?: false; error: string };

function shouldWriteIssueOutput(options: CreateIssueFromTaskOptions | undefined): boolean {
  return options?.outputMode !== 'silent';
}

function requireIssueFailureMessage(message: string | undefined): string {
  if (!message) {
    throw new Error('Issue creation failed without an error message');
  }
  return message;
}

function resolveCreatedIssueNumber(issueResult: Extract<CreateIssueResult, { success: true }>): number {
  if (Number.isSafeInteger(issueResult.issueNumber) && issueResult.issueNumber > 0) {
    return issueResult.issueNumber;
  }
  throw new Error(`Issue number must be a positive safe integer: ${issueResult.issueNumber}`);
}

function formatIssueNumberExtractionError(extractionError: unknown): string {
  const cause = extractionError instanceof Error ? extractionError.message : String(extractionError);
  return safeExternalErrorMessage(`Failed to extract issue number: ${cause}`);
}

export function createIssueFromTaskResult(
  task: string,
  options?: CreateIssueFromTaskOptions,
): CreateIssueFromTaskResult {
  if (shouldWriteIssueOutput(options)) {
    info('Creating issue...');
  }
  let resolvedTitle: ReturnType<typeof resolveIssueTitle>;
  try {
    resolvedTitle = resolveIssueTitle(task, options?.title, options?.explicitTitle);
  } catch (titleError) {
    const message = titleError instanceof Error ? titleError.message : String(titleError);
    if (shouldWriteIssueOutput(options)) {
      error(`Failed to create issue: ${message}`);
    }
    log.error('Failed to create issue', {
      error: message,
      used_structured_output: false,
      fallback_reason: getStructuredTitleFallbackReason(options?.title),
    });
    return { success: false, error: message };
  }
  const { title, usedStructuredOutput, fallbackReason } = resolvedTitle;
  const effectiveLabels = options?.labels?.filter((l) => l.length > 0) ?? [];
  const labels = effectiveLabels.length > 0 ? effectiveLabels : undefined;

  const gitProvider = options?.gitProvider ?? getGitProvider();
  const issueResult = gitProvider.createIssue({ title, body: task, labels }, options?.cwd);
  if (issueResult.success) {
    let issueNumber: number;
    try {
      issueNumber = resolveCreatedIssueNumber(issueResult);
    } catch (extractionError) {
      const message = formatIssueNumberExtractionError(extractionError);
      if (shouldWriteIssueOutput(options)) {
        error(message);
      }
      log.error('Failed to create issue', {
        error: message,
        used_structured_output: usedStructuredOutput,
        ...(fallbackReason !== undefined ? { fallback_reason: fallbackReason } : {}),
      });
      const issueUrl = normalizePublicIssueUrl(issueResult.url);
      return {
        success: false,
        issueCreated: true,
        ...(issueUrl !== undefined ? { issueUrl } : {}),
        error: message,
      };
    }
    const issueUrl = normalizePublicIssueUrl(issueResult.url);
    if (shouldWriteIssueOutput(options)) {
      success(issueUrl ? `Issue created: ${issueUrl}` : `Issue created: #${issueNumber}`);
    }
    log.info('Issue created', {
      url: issueUrl,
      issueNumber,
      used_structured_output: usedStructuredOutput,
      ...(fallbackReason !== undefined ? { fallback_reason: fallbackReason } : {}),
    });
    return {
      success: true,
      issueNumber,
      ...(issueUrl !== undefined ? { issueUrl } : {}),
    };
  }

  if (issueResult.issueCreated) {
    const message = requireIssueFailureMessage(issueResult.error);
    if (shouldWriteIssueOutput(options)) {
      error(`Issue was created, but its number could not be extracted: ${message}`);
    }
    log.error('Issue number extraction failed after issue creation', {
      error: message,
      used_structured_output: usedStructuredOutput,
      ...(fallbackReason !== undefined ? { fallback_reason: fallbackReason } : {}),
    });
    const issueUrl = normalizePublicIssueUrl(issueResult.url);
    return {
      success: false,
      issueCreated: true,
      ...(issueUrl !== undefined ? { issueUrl } : {}),
      error: message,
    };
  }

  const message = requireIssueFailureMessage(issueResult.error);
  if (shouldWriteIssueOutput(options)) {
    error(`Failed to create issue: ${message}`);
  }
  log.error('Failed to create issue', {
    error: message,
    used_structured_output: usedStructuredOutput,
    ...(fallbackReason !== undefined ? { fallback_reason: fallbackReason } : {}),
  });
  return { success: false, error: message };
}

export function createIssueFromTask(
  task: string,
  options?: CreateIssueFromTaskOptions,
): number | undefined {
  const result = createIssueFromTaskResult(task, options);
  return result.success ? result.issueNumber : undefined;
}
