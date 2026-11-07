import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { sanitizePathText } from '../../shared/utils/pathText.js';

export const CACCIA_REPORT_FILE_NAME = 'caccia-decisions.json';

export interface CacciaWorkflowDecision {
  threadId: string;
  valid: boolean;
  reason: string;
}

export interface CacciaWorkflowReport {
  outcome: 'complete' | 'abort';
  reason: string;
  decisions: CacciaWorkflowDecision[];
}

export class CacciaWorkflowError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(sanitizePathText(sanitizeSensitiveText(message)).replaceAll('@', '＠'), options);
    this.name = 'CacciaWorkflowError';
  }
}

export function parseCacciaWorkflowReport(contents: string): CacciaWorkflowReport {
  const parsed: unknown = JSON.parse(contents);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The ${CACCIA_REPORT_FILE_NAME} report must contain a JSON object`);
  }
  const report = parsed as Record<string, unknown>;
  if ((report.outcome !== 'complete' && report.outcome !== 'abort')
    || typeof report.reason !== 'string' || !Array.isArray(report.decisions)) {
    throw new Error(`Invalid outcome, reason, or decisions in ${CACCIA_REPORT_FILE_NAME}`);
  }
  if (report.outcome === 'abort' && report.reason.trim().length === 0) {
    throw new Error(`An abort reason is required in ${CACCIA_REPORT_FILE_NAME}`);
  }
  const decisions = report.decisions.map((entry: unknown, index: number): CacciaWorkflowDecision => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Invalid decision at index ${index} in ${CACCIA_REPORT_FILE_NAME}`);
    }
    const decision = entry as Record<string, unknown>;
    if (typeof decision.thread_id !== 'string' || typeof decision.valid !== 'boolean'
      || typeof decision.reason !== 'string' || decision.reason.trim().length === 0) {
      throw new Error(`Incomplete decision at index ${index} in ${CACCIA_REPORT_FILE_NAME}`);
    }
    return { threadId: decision.thread_id, valid: decision.valid, reason: decision.reason };
  });
  return { outcome: report.outcome, reason: report.reason, decisions };
}

export function assertCacciaWorkflowComplete(
  report: CacciaWorkflowReport,
  threadIds: readonly string[],
  workflowFailure?: string,
): void {
  const expected = new Set(threadIds);
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const decision of report.decisions) {
    if (!expected.has(decision.threadId) || seen.has(decision.threadId)) {
      problems.push(`The Caccia workflow returned an unexpected or duplicate decision for ${decision.threadId}`);
    }
    seen.add(decision.threadId);
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length > 0) {
    problems.push(`The Caccia workflow did not report decisions for all review threads: ${missing.join(', ')}`);
  }
  if (report.outcome === 'abort') problems.push('The Caccia workflow reported abort');
  if (workflowFailure !== undefined) problems.push(workflowFailure);
  if (problems.length > 0) {
    throw new CacciaWorkflowError([report.reason, ...problems].filter((part) => part.trim().length > 0).join('; '));
  }
}
