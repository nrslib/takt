import { randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import { MAX_AGENT_FAILURE_MESSAGE_BYTES } from '../../shared/types/agent-failure.js';
import { ensurePrivateDirectory, writeNewPrivateFileWithMode } from '../../shared/utils/private-file.js';
import { truncateUtf8WithMarker } from '../../shared/utils/text.js';
import type { CodexCallOptions } from './types.js';

const CODEX_FAILURE_FILE_PREFIX = 'provider-failure';
const CODEX_FAILURE_FILE_MODE = 0o600;

type CodexFailureMessageOptions = Pick<CodexCallOptions, 'cwd' | 'failureDir'>;

export function boundCodexFailureMessage(
  message: string,
  options: CodexFailureMessageOptions,
  persistFullText: boolean,
): string {
  const totalBytes = Buffer.byteLength(message, 'utf8');
  if (totalBytes <= MAX_AGENT_FAILURE_MESSAGE_BYTES) {
    return message;
  }

  let fullTextPath: string | undefined;
  if (persistFullText && options.failureDir !== undefined) {
    const filePath = join(
      options.failureDir,
      `${CODEX_FAILURE_FILE_PREFIX}-${randomUUID()}.txt`,
    );
    try {
      ensurePrivateDirectory(options.failureDir);
      writeNewPrivateFileWithMode(filePath, message, CODEX_FAILURE_FILE_MODE);
      fullTextPath = relative(options.cwd, filePath);
    } catch {
      fullTextPath = undefined;
    }
  }

  return truncateUtf8WithMarker(
    message,
    MAX_AGENT_FAILURE_MESSAGE_BYTES,
    (omittedBytes) => fullTextPath === undefined
      ? `[TRUNCATED: ${omittedBytes} bytes]`
      : `[TRUNCATED: ${omittedBytes} bytes, full text: ${fullTextPath}]`,
  );
}
