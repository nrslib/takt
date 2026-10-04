import { appendPrivateFile } from '../../../shared/utils/private-file.js';
import { safeExternalErrorMessage } from '../../../shared/utils/safeExternalErrorMessage.js';
import { createLogger } from '../../../shared/utils/index.js';

const log = createLogger('prompt-log');

export interface PromptLogRecord {
  step: string;
  phase: 1 | 2 | 3;
  iteration: number;
  scope: string;
  phaseExecutionId: string;
  prompt: string;
  systemPrompt: string;
  userInstruction: string;
  response: string;
  timestamp: string;
}

export function writePromptLog(
  promptLogPath: string,
  record: PromptLogRecord,
): void {
  try {
    appendPrivateFile(promptLogPath, JSON.stringify(record) + '\n');
  } catch (error) {
    log.warn('Prompt log could not be persisted; continuing workflow', {
      error: safeExternalErrorMessage(error),
    });
  }
}
