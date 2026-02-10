/**
 * Claude Code session reader
 *
 * Reads Claude Code's sessions-index.json and individual .jsonl session files
 * to extract session metadata and last assistant responses.
 */

import { existsSync, readFileSync } from 'node:fs';
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
    return [];
  }

  const content = readFileSync(indexPath, 'utf-8');

  let index: SessionsIndex;
  try {
    index = JSON.parse(content) as SessionsIndex;
  } catch {
    return [];
  }

  if (!index.entries || !Array.isArray(index.entries)) {
    return [];
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
