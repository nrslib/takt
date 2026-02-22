/**
 * Claude Code session reader
 *
 * Reads Claude Code's sessions-index.json and individual .jsonl session files
 * to extract session metadata and last assistant responses.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getClaudeProjectSessionsDir } from '../config/project/sessionStore.js';

/** Entry in Claude Code's sessions-index.json */
export interface SessionIndexEntry {
  sessionId: string;
  firstPrompt: string;
  modified: string;
  messageCount: number;
  gitBranch: string;
  isSidechain: boolean;
  fullPath: string;
}

/** Shape of sessions-index.json */
interface SessionsIndex {
  version: number;
  entries: SessionIndexEntry[];
}

interface SessionMessageContent {
  type: string;
  text?: string;
}

interface SessionMessage {
  content?: SessionMessageContent[];
}

interface SessionJsonlRecord {
  type?: string;
  sessionId?: string;
  message?: SessionMessage;
  timestamp?: string;
  gitBranch?: string;
  isSidechain?: boolean;
}

function buildEntryFromJsonlFile(sessionsDir: string, fileName: string): SessionIndexEntry | null {
  const fullPath = join(sessionsDir, fileName);
  const sessionId = fileName.replace(/\.jsonl$/, '');

  if (!sessionId || sessionId === fileName) {
    return null;
  }

  let firstPrompt = '';
  let messageCount = 0;
  let gitBranch = '';
  let isSidechain = false;

  try {
    const content = readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    for (const line of lines) {
      let record: SessionJsonlRecord;
      try {
        record = JSON.parse(line) as SessionJsonlRecord;
      } catch {
        continue;
      }

      if (record.type === 'user' || record.type === 'assistant') {
        messageCount += 1;
      }

      if (!gitBranch && typeof record.gitBranch === 'string') {
        gitBranch = record.gitBranch;
      }

      if (record.isSidechain === true) {
        isSidechain = true;
      }

      if (!firstPrompt && record.type === 'user' && Array.isArray(record.message?.content)) {
        const textBlock = record.message.content.find((block) => block.type === 'text' && typeof block.text === 'string');
        if (textBlock?.text) {
          firstPrompt = textBlock.text.trim();
        }
      }
    }
  } catch {
    return null;
  }

  const modified = statSync(fullPath).mtime.toISOString();

  return {
    sessionId,
    firstPrompt: firstPrompt || sessionId,
    modified,
    messageCount,
    gitBranch,
    isSidechain,
    fullPath,
  };
}

function loadSessionIndexFromJsonl(sessionsDir: string): SessionIndexEntry[] {
  if (!existsSync(sessionsDir)) {
    return [];
  }

  const jsonlFiles = readdirSync(sessionsDir)
    .filter((name) => name.endsWith('.jsonl'));

  return jsonlFiles
    .map((fileName) => buildEntryFromJsonlFile(sessionsDir, fileName))
    .filter((entry): entry is SessionIndexEntry => entry !== null)
    .filter((entry) => !entry.isSidechain)
    .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
}

/**
 * Load the session index for a project directory.
 *
 * Reads ~/.claude/projects/{encoded-path}/sessions-index.json,
 * filters out sidechain sessions, and sorts by modified descending.
 */
export function loadSessionIndex(projectDir: string): SessionIndexEntry[] {
  const sessionsDir = getClaudeProjectSessionsDir(projectDir);
  const indexPath = join(sessionsDir, 'sessions-index.json');

  if (!existsSync(indexPath)) {
    return loadSessionIndexFromJsonl(sessionsDir);
  }

  const content = readFileSync(indexPath, 'utf-8');

  let index: SessionsIndex;
  try {
    index = JSON.parse(content) as SessionsIndex;
  } catch {
    return loadSessionIndexFromJsonl(sessionsDir);
  }

  if (!index.entries || !Array.isArray(index.entries)) {
    return loadSessionIndexFromJsonl(sessionsDir);
  }

  return index.entries
    .filter((entry) => !entry.isSidechain)
    .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
}

/** Content block with text type from Claude API */
interface TextContentBlock {
  type: 'text';
  text: string;
}

/** Message structure in JSONL records */
interface AssistantMessage {
  content: Array<TextContentBlock | { type: string }>;
}

/** JSONL record for assistant messages */
interface SessionRecord {
  type: string;
  message?: AssistantMessage;
}

/**
 * Extract the last assistant text response from a session JSONL file.
 *
 * Reads the file and scans from the end to find the last `type: "assistant"`
 * record with a text content block. Returns the truncated text.
 */
export function extractLastAssistantResponse(sessionFilePath: string, maxLength: number): string | null {
  if (!existsSync(sessionFilePath)) {
    return null;
  }

  const content = readFileSync(sessionFilePath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim());

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;

    let record: SessionRecord;
    try {
      record = JSON.parse(line) as SessionRecord;
    } catch {
      continue;
    }

    if (record.type !== 'assistant' || !record.message?.content) {
      continue;
    }

    const textBlocks = record.message.content.filter(
      (block): block is TextContentBlock => block.type === 'text',
    );

    if (textBlocks.length === 0) {
      continue;
    }

    const fullText = textBlocks.map((b) => b.text).join('\n');
    if (fullText.length <= maxLength) {
      return fullText;
    }
    return fullText.slice(0, maxLength) + '…';
  }

  return null;
}
