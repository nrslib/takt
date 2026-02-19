/**
 * Slack Incoming Webhook notification
 *
 * Sends a text message to a Slack channel via Incoming Webhook.
 * Activated only when TAKT_NOTIFY_WEBHOOK environment variable is set.
 */

const WEBHOOK_ENV_KEY = 'TAKT_NOTIFY_WEBHOOK';
const TIMEOUT_MS = 10_000;

/**
 * Send a notification message to Slack via Incoming Webhook.
 *
 * Never throws: errors are written to stderr so the caller's flow is not disrupted.
 */
export async function sendSlackNotification(webhookUrl: string, message: string): Promise<void> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      process.stderr.write(
        `Slack webhook failed: HTTP ${String(response.status)} ${response.statusText}\n`,
      );
    }
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Slack webhook error: ${detail}\n`);
  }
}

/**
 * Read the Slack webhook URL from the environment.
 *
 * @returns The webhook URL, or undefined if the environment variable is not set.
 */
export function getSlackWebhookUrl(): string | undefined {
  return process.env[WEBHOOK_ENV_KEY];
}

export interface SlackTaskDetail {
  name: string;
  success: boolean;
  piece: string;
  issueNumber?: number;
  durationSec: number;
  branch?: string;
  worktreePath?: string;
  prUrl?: string;
  failureMovement?: string;
  failureError?: string;
  failureLastMessage?: string;
}

export interface SlackRunSummaryParams {
  runId: string;
  total: number;
  success: number;
  failed: number;
  durationSec: number;
  concurrency: number;
  tasks: SlackTaskDetail[];
}

const CHAR_LIMIT = 3_800;
const TRUNCATE_LENGTH = 120;

function normalizeText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function formatTaskLines(task: SlackTaskDetail): string {
  const icon = task.success ? '\u2705' : '\u274C';
  const parts = [
    `${icon} ${task.name}`,
    `piece=${task.piece}`,
  ];
  if (task.issueNumber !== undefined) {
    parts.push(`issue=#${String(task.issueNumber)}`);
  }
  parts.push(`duration=${String(task.durationSec)}s`);
  const line1 = parts.join(' | ');

  const line2Parts: string[] = [];
  if (task.success) {
    if (task.branch) line2Parts.push(`branch=${task.branch}`);
    if (task.worktreePath) line2Parts.push(`worktree=${task.worktreePath}`);
    if (task.prUrl) line2Parts.push(`pr=${task.prUrl}`);
  } else {
    if (task.failureMovement) line2Parts.push(`movement=${task.failureMovement}`);
    if (task.failureError) {
      line2Parts.push(`error=${truncateText(normalizeText(task.failureError), TRUNCATE_LENGTH)}`);
    }
    if (task.failureLastMessage) {
      line2Parts.push(`last=${truncateText(normalizeText(task.failureLastMessage), TRUNCATE_LENGTH)}`);
    }
    if (task.branch) line2Parts.push(`branch=${task.branch}`);
    if (task.prUrl) line2Parts.push(`pr=${task.prUrl}`);
  }

  if (line2Parts.length === 0) {
    return line1;
  }
  return `${line1}\n  ${line2Parts.join(' | ')}`;
}

export function buildSlackRunSummary(params: SlackRunSummaryParams): string {
  const headerLine = `\uD83C\uDFC3 TAKT Run ${params.runId}`;
  const statsLine = `total=${String(params.total)} | success=${String(params.success)} | failed=${String(params.failed)} | duration=${String(params.durationSec)}s | concurrency=${String(params.concurrency)}`;
  const summaryBlock = `${headerLine}\n${statsLine}`;

  let result = summaryBlock;
  let includedCount = 0;

  for (const task of params.tasks) {
    const taskBlock = formatTaskLines(task);
    const candidate = `${result}\n\n${taskBlock}`;

    const remaining = params.tasks.length - includedCount - 1;
    const suffixLength = remaining > 0 ? `\n...and ${String(remaining)} more`.length : 0;

    if (candidate.length + suffixLength > CHAR_LIMIT) {
      break;
    }

    result = candidate;
    includedCount++;
  }

  const omitted = params.tasks.length - includedCount;
  if (omitted > 0) {
    result = `${result}\n...and ${String(omitted)} more`;
  }

  return result;
}
