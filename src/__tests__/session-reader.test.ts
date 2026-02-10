/**
 * Tests for Claude Code session reader
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock getClaudeProjectSessionsDir to point to our temp directory
let mockSessionsDir: string;

vi.mock('../infra/config/project/sessionStore.js', () => ({
  getClaudeProjectSessionsDir: vi.fn(() => mockSessionsDir),
}));

import { loadSessionIndex, extractLastAssistantResponse } from '../infra/claude/session-reader.js';

describe('loadSessionIndex', () => {
  beforeEach(() => {
    mockSessionsDir = mkdtempSync(join(tmpdir(), 'session-reader-test-'));
  });

  it('returns empty array when sessions-index.json does not exist', () => {
    const result = loadSessionIndex('/nonexistent');
    expect(result).toEqual([]);
  });

  it('reads and parses sessions-index.json correctly', () => {
    const indexData = {
      version: 1,
      entries: [
        {
          sessionId: 'aaa',
          firstPrompt: 'First session',
          modified: '2026-01-28T10:00:00.000Z',
          messageCount: 5,
          gitBranch: 'main',
          isSidechain: false,
          fullPath: '/path/to/aaa.jsonl',
        },
        {
          sessionId: 'bbb',
          firstPrompt: 'Second session',
          modified: '2026-01-29T10:00:00.000Z',
          messageCount: 10,
          gitBranch: '',
          isSidechain: false,
          fullPath: '/path/to/bbb.jsonl',
        },
      ],
    };

    writeFileSync(join(mockSessionsDir, 'sessions-index.json'), JSON.stringify(indexData));

    const result = loadSessionIndex('/any');
    expect(result).toHaveLength(2);
    // Sorted by modified descending: bbb (Jan 29) first, then aaa (Jan 28)
    expect(result[0]!.sessionId).toBe('bbb');
    expect(result[1]!.sessionId).toBe('aaa');
  });

  it('filters out sidechain sessions', () => {
    const indexData = {
      version: 1,
      entries: [
        {
          sessionId: 'main-session',
          firstPrompt: 'User conversation',
          modified: '2026-01-28T10:00:00.000Z',
          messageCount: 5,
          gitBranch: '',
          isSidechain: false,
          fullPath: '/path/to/main.jsonl',
        },
        {
          sessionId: 'sidechain-session',
          firstPrompt: 'Sub-agent work',
          modified: '2026-01-29T10:00:00.000Z',
          messageCount: 20,
          gitBranch: '',
          isSidechain: true,
          fullPath: '/path/to/sidechain.jsonl',
        },
      ],
    };

    writeFileSync(join(mockSessionsDir, 'sessions-index.json'), JSON.stringify(indexData));

    const result = loadSessionIndex('/any');
    expect(result).toHaveLength(1);
    expect(result[0]!.sessionId).toBe('main-session');
  });

  it('returns empty array when entries is missing', () => {
    writeFileSync(join(mockSessionsDir, 'sessions-index.json'), JSON.stringify({ version: 1 }));

    const result = loadSessionIndex('/any');
    expect(result).toEqual([]);
  });

  it('returns empty array when sessions-index.json contains corrupted JSON', () => {
    writeFileSync(join(mockSessionsDir, 'sessions-index.json'), '{corrupted json content');

    const result = loadSessionIndex('/any');
    expect(result).toEqual([]);
  });
});

describe('extractLastAssistantResponse', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-reader-extract-'));
  });

  it('returns null when file does not exist', () => {
    const result = extractLastAssistantResponse('/nonexistent/file.jsonl', 200);
    expect(result).toBeNull();
  });

  it('extracts text from last assistant message', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'First response' }] },
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Follow up' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Last response here' }] },
      }),
    ];

    const filePath = join(tempDir, 'session.jsonl');
    writeFileSync(filePath, lines.join('\n'));

    const result = extractLastAssistantResponse(filePath, 200);
    expect(result).toBe('Last response here');
  });

  it('skips assistant messages with only tool_use content', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Text response' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
      }),
    ];

    const filePath = join(tempDir, 'session.jsonl');
    writeFileSync(filePath, lines.join('\n'));

    const result = extractLastAssistantResponse(filePath, 200);
    expect(result).toBe('Text response');
  });

  it('returns null when no assistant messages have text', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
      }),
    ];

    const filePath = join(tempDir, 'session.jsonl');
    writeFileSync(filePath, lines.join('\n'));

    const result = extractLastAssistantResponse(filePath, 200);
    expect(result).toBeNull();
  });

  it('truncates long responses', () => {
    const longText = 'A'.repeat(300);
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: longText }] },
      }),
    ];

    const filePath = join(tempDir, 'session.jsonl');
    writeFileSync(filePath, lines.join('\n'));

    const result = extractLastAssistantResponse(filePath, 200);
    expect(result).toHaveLength(201); // 200 chars + '…'
    expect(result!.endsWith('…')).toBe(true);
  });

  it('concatenates multiple text blocks in a single message', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Part one' },
            { type: 'tool_use', id: 'tool1', name: 'Read', input: {} },
            { type: 'text', text: 'Part two' },
          ],
        },
      }),
    ];

    const filePath = join(tempDir, 'session.jsonl');
    writeFileSync(filePath, lines.join('\n'));

    const result = extractLastAssistantResponse(filePath, 200);
    expect(result).toBe('Part one\nPart two');
  });

  it('handles malformed JSON lines gracefully', () => {
    const lines = [
      'not valid json',
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Valid response' }] },
      }),
      '{also broken',
    ];

    const filePath = join(tempDir, 'session.jsonl');
    writeFileSync(filePath, lines.join('\n'));

    const result = extractLastAssistantResponse(filePath, 200);
    expect(result).toBe('Valid response');
  });

  it('handles progress and other non-assistant record types', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Response' }] },
      }),
      JSON.stringify({
        type: 'progress',
        data: { type: 'hook_progress' },
      }),
    ];

    const filePath = join(tempDir, 'session.jsonl');
    writeFileSync(filePath, lines.join('\n'));

    const result = extractLastAssistantResponse(filePath, 200);
    expect(result).toBe('Response');
  });
});
