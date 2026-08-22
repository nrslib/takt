import * as os from 'node:os';
import * as path from 'node:path';
import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';
import type { CommandQualityGateFailure } from './types.js';

export { sanitizeSensitiveText };

const MAX_FEEDBACK_CHARS = 1_000;

function truncateForFeedback(text: string): string {
  if (text.length <= MAX_FEEDBACK_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_FEEDBACK_CHARS)}\n[TRUNCATED ${text.length - MAX_FEEDBACK_CHARS} chars]`;
}

function maskKnownPaths(text: string, projectRoot: string): string {
  const homeDir = os.homedir();
  return text
    .replaceAll(projectRoot, '<project-root>')
    .replaceAll(homeDir, '<home>');
}

function sanitizeForFeedback(text: string, projectRoot: string): string {
  return truncateForFeedback(sanitizeSensitiveText(maskKnownPaths(text, projectRoot)));
}

function formatCwd(failure: CommandQualityGateFailure): string {
  const relative = path.relative(failure.projectRoot, failure.cwd);
  if (relative === '') {
    return '.';
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return '<outside-project>';
  }
  return relative;
}

function formatProjectRelativePath(projectRoot: string, targetPath: string): string {
  const relative = path.relative(projectRoot, targetPath);
  if (relative === '') {
    return '.';
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return '<outside-project>';
  }
  return relative;
}

function formatOutputLog(failure: CommandQualityGateFailure): string {
  if (failure.outputLogPath) {
    return formatProjectRelativePath(failure.projectRoot, failure.outputLogPath);
  }
  if (failure.outputLogError) {
    return `unavailable: ${sanitizeForFeedback(failure.outputLogError, failure.projectRoot)}`;
  }
  return 'not created';
}

export function formatCommandGateFailure(failure: CommandQualityGateFailure): string {
  const lines = [
    `Quality gate failed: ${sanitizeForFeedback(failure.gateName, failure.projectRoot)}`,
    'Type: command',
    `Command: ${sanitizeForFeedback(failure.command, failure.projectRoot)}`,
    `Cwd: ${formatCwd(failure)}`,
  ];

  if (failure.timedOut) {
    lines.push(`Timeout: ${failure.timeoutMs}ms`);
  } else if (failure.outputLimitExceeded) {
    lines.push(`Output limit exceeded: ${failure.outputLimitBytes} bytes`);
  } else {
    lines.push(`Exit code: ${failure.exitCode}`);
  }

  lines.push(
    '',
    `Output log: ${formatOutputLog(failure)}`,
  );

  return lines.join('\n');
}
