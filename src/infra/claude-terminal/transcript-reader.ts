import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AskUserQuestionInput } from '../../core/workflow/types.js';
import { getClaudeProjectSessionsDir } from '../config/project/sessionStore.js';
import type {
  ClaudeSessionRef,
  ClaudeTranscriptBaseline,
  ClaudeTerminalEvent,
  ClaudeTerminalTranscript,
  ClaudeTranscriptReader,
  FindClaudeSessionOptions,
  WaitForClaudeResponseOptions,
} from './types.js';

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Malformed Claude terminal transcript: ${field} must be a non-empty string.`);
  }
  return value;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  const record = toRecord(value);
  if (!record) {
    throw new Error(`Malformed Claude terminal transcript: ${field} must be an object.`);
  }
  return record;
}

function extractTextContent(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap<string>((item) => {
    const record = toRecord(item);
    return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
  });
}

function readQuestion(record: Record<string, unknown>, field: string): AskUserQuestionInput['questions'][number] {
  const question = requireString(record.question, `${field}.question`);
  const output: AskUserQuestionInput['questions'][number] = { question };
  if (typeof record.header === 'string') {
    output.header = record.header;
  }
  if (typeof record.multiSelect === 'boolean') {
    output.multiSelect = record.multiSelect;
  }
  if (Array.isArray(record.options)) {
    output.options = record.options.map((option, index) => {
      const optionRecord = requireRecord(option, `${field}.options[${index}]`);
      const parsed = { label: requireString(optionRecord.label, `${field}.options[${index}].label`) };
      return typeof optionRecord.description === 'string'
        ? { ...parsed, description: optionRecord.description }
        : parsed;
    });
  }
  return output;
}

function readQuestions(input: Record<string, unknown>, field: string): AskUserQuestionInput['questions'] {
  if (!Array.isArray(input.questions) || input.questions.length === 0) {
    throw new Error(`Malformed Claude terminal transcript: ${field}.questions must be a non-empty array.`);
  }
  return input.questions.map((question, index) =>
    readQuestion(requireRecord(question, `${field}.questions[${index}]`), `${field}.questions[${index}]`)
  );
}

function extractToolUseEvents(content: unknown): ClaudeTerminalEvent[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap<ClaudeTerminalEvent>((item) => {
    const record = toRecord(item);
    if (record?.type !== 'tool_use') {
      return [];
    }
    const tool = requireString(record.name, 'tool_use.name');
    const input = requireRecord(record.input, 'tool_use.input');
    if (tool === 'AskUserQuestion') {
      return [{
        type: 'ask_user_question' as const,
        questions: readQuestions(input, 'tool_use.input'),
      }];
    }
    return [{
      type: 'tool_use' as const,
      id: requireString(record.id, 'tool_use.id'),
      tool,
      input,
    }];
  });
}

function readSessionId(entry: Record<string, unknown>, currentSessionId: string): string {
  if (typeof entry.session_id === 'string' && entry.session_id.length > 0) {
    return entry.session_id;
  }
  if (typeof entry.sessionId === 'string' && entry.sessionId.length > 0) {
    return entry.sessionId;
  }
  return currentSessionId;
}

function appendTranscriptEntry(
  parsed: ClaudeTerminalTranscript,
  entry: Record<string, unknown>,
): ClaudeTerminalTranscript {
  const sessionId = readSessionId(entry, parsed.sessionId);
  if (entry.type === 'assistant') {
    const message = toRecord(entry.message);
    const text = extractTextContent(message?.content);
    const events = extractToolUseEvents(message?.content);
    return {
      sessionId,
      assistantText: [...(parsed.assistantText ? [parsed.assistantText] : []), ...text].join('\n'),
      events: [...parsed.events, ...events],
    };
  }
  if (entry.type === 'permission_request') {
    return {
      sessionId,
      assistantText: parsed.assistantText,
      events: [...parsed.events, {
        type: 'permission_request',
        tool: requireString(entry.tool, 'permission_request.tool'),
        input: requireRecord(entry.input, 'permission_request.input'),
      }],
    };
  }
	  if (entry.type === 'ask_user_question') {
	    return {
	      sessionId,
	      assistantText: parsed.assistantText,
	      events: [...parsed.events, {
	        type: 'ask_user_question',
	        questions: [{
	          question: requireString(entry.question, 'ask_user_question.question'),
	        }],
	      }],
	    };
  }
  return { ...parsed, sessionId };
}

function parseTranscriptLine(line: string, lineNumber: number): Record<string, unknown> {
  try {
    return requireRecord(JSON.parse(line), `line ${lineNumber}`);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Malformed Claude terminal transcript JSON at line ${lineNumber}: ${error.message}`);
    }
    throw error;
  }
}

function countLineNumberOffset(transcript: string): number {
  return [...transcript.matchAll(/\n/g)].length;
}

function transcriptSinceBaseline(transcript: string, baseline: ClaudeTranscriptBaseline | undefined): string {
  if (!baseline) {
    return transcript;
  }
  const transcriptBytes = Buffer.from(transcript, 'utf-8');
  if (transcriptBytes.byteLength < baseline.byteOffset) {
    throw new Error('Malformed Claude terminal transcript: transcript is shorter than the response baseline.');
  }
  return transcriptBytes.subarray(baseline.byteOffset).toString('utf-8');
}

function hasCompletionEntry(transcript: string, baseline: ClaudeTranscriptBaseline): boolean {
  const lineNumberOffset = baseline.lineNumberOffset;
  return transcriptSinceBaseline(transcript, baseline)
    .split(/\r?\n/)
    .some((rawLine, index) => {
      const line = rawLine.trim();
      if (line.length === 0) {
        return false;
      }
      return parseTranscriptLine(line, index + 1 + lineNumberOffset).type === 'result';
    });
}

export function parseClaudeTerminalTranscript(
  transcript: string,
  baseline?: ClaudeTranscriptBaseline,
): ClaudeTerminalTranscript {
  const lineNumberOffset = baseline?.lineNumberOffset ?? 0;
  return transcriptSinceBaseline(transcript, baseline)
    .split(/\r?\n/)
    .reduce<ClaudeTerminalTranscript>((parsed, rawLine, index) => {
      const line = rawLine.trim();
      if (line.length === 0) {
        return parsed;
      }
      return appendTranscriptEntry(parsed, parseTranscriptLine(line, index + 1 + lineNumberOffset));
    }, { sessionId: '', assistantText: '', events: [] });
}

function hasBlockingInteractiveEvent(transcript: ClaudeTerminalTranscript): boolean {
  return transcript.events.some((event) =>
    event.type === 'permission_request' || event.type === 'ask_user_question'
  );
}

function withSessionIdFallback(
  transcript: ClaudeTerminalTranscript,
  sessionId: string,
): ClaudeTerminalTranscript {
  return transcript.sessionId ? transcript : { ...transcript, sessionId };
}

async function pollUntil<T>(
  timeoutMs: number,
  pollIntervalMs: number,
  attempt: () => Promise<T | undefined>,
  timeoutMessage: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = await attempt();
    if (value !== undefined) {
      return value;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(timeoutMessage);
}

function requireSafeSessionFilename(sessionId: string): string {
  if (
    sessionId.length === 0
    || sessionId === '.'
    || sessionId === '..'
    || sessionId.includes('/')
    || sessionId.includes('\\')
  ) {
    throw new Error('Invalid Claude terminal session id: session id must be a single transcript filename.');
  }
  return `${sessionId}.jsonl`;
}

function transcriptPath(cwd: string, sessionId: string): string {
  const baseDir = resolve(getClaudeProjectSessionsDir(cwd));
  const resolvedPath = resolve(baseDir, requireSafeSessionFilename(sessionId));
  if (!resolvedPath.startsWith(`${baseDir}${sep}`)) {
    throw new Error('Invalid Claude terminal session id: transcript path escapes the project session directory.');
  }
  return resolvedPath;
}

function isFileMissing(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'ENOENT';
}

async function readTranscript(cwd: string, sessionId: string): Promise<string | undefined> {
  try {
    return await readFile(transcriptPath(cwd, sessionId), 'utf-8');
  } catch (error) {
    if (isFileMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

export class ProjectClaudeTranscriptReader implements ClaudeTranscriptReader {
  async readBaseline(options: Pick<FindClaudeSessionOptions, 'cwd' | 'sessionId'>): Promise<ClaudeTranscriptBaseline> {
    const transcript = await readTranscript(options.cwd, options.sessionId);
    if (transcript === undefined) {
      return { byteOffset: 0, lineNumberOffset: 0 };
    }
    return {
      byteOffset: Buffer.byteLength(transcript, 'utf-8'),
      lineNumberOffset: countLineNumberOffset(transcript),
    };
  }

  async findSession(options: FindClaudeSessionOptions): Promise<ClaudeSessionRef> {
    return pollUntil(
      options.timeoutMs,
      options.pollIntervalMs,
      async () => {
        const transcript = await readTranscript(options.cwd, options.sessionId);
        if (transcript === undefined || transcript.trim().length === 0) {
          return undefined;
        }
        const parsed = parseClaudeTerminalTranscript(transcript);
        return { sessionId: parsed.sessionId || options.sessionId };
      },
      'Timed out waiting for Claude terminal session id.',
    );
  }

  async waitForAssistantResponse(options: WaitForClaudeResponseOptions): Promise<ClaudeTerminalTranscript> {
    return pollUntil(
      options.timeoutMs,
      options.pollIntervalMs,
      async () => {
        const transcript = await readTranscript(options.cwd, options.session.sessionId);
        if (transcript === undefined || transcript.trim().length === 0) {
          return undefined;
        }
        const parsed = parseClaudeTerminalTranscript(transcript, options.baseline);
        if (hasBlockingInteractiveEvent(parsed)) {
          return withSessionIdFallback(parsed, options.session.sessionId);
        }
        if (!parsed.assistantText) {
          return undefined;
        }
        if (!hasCompletionEntry(transcript, options.baseline)) {
          return undefined;
        }
        return withSessionIdFallback(parsed, options.session.sessionId);
      },
      'Timed out waiting for Claude terminal assistant response.',
    );
  }
}
