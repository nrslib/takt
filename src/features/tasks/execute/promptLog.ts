import { appendPrivateFile } from '../../../shared/utils/private-file.js';

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
  } catch {
    // Logging errors must not interrupt the workflow.
  }
}
