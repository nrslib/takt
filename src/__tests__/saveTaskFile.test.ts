/**
 * Tests for saveTaskFile and saveTaskFromInteractive
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../infra/task/summarize.js', () => ({
  summarizeTaskName: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  success: vi.fn(),
  info: vi.fn(),
  blankLine: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  confirm: vi.fn(),
  promptInput: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { summarizeTaskName } from '../infra/task/summarize.js';
import { success, info } from '../shared/ui/index.js';
import { confirm, promptInput } from '../shared/prompt/index.js';
import { saveTaskFile, saveTaskFromInteractive } from '../features/tasks/add/index.js';

const mockSummarizeTaskName = vi.mocked(summarizeTaskName);
const mockSuccess = vi.mocked(success);
const mockInfo = vi.mocked(info);
const mockConfirm = vi.mocked(confirm);
const mockPromptInput = vi.mocked(promptInput);

let testDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  testDir = fs.mkdtempSync(path.join(tmpdir(), 'takt-test-save-'));
  mockSummarizeTaskName.mockResolvedValue('test-task');
});

afterEach(() => {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }
});

describe('saveTaskFile', () => {
  it('should create task file with correct YAML content', async () => {
    // Given
    const taskContent = 'Implement feature X\nDetails here';

    // When
    const filePath = await saveTaskFile(testDir, taskContent);

    // Then
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('Implement feature X');
    expect(content).toContain('Details here');
  });

  it('should create .takt/tasks directory if it does not exist', async () => {
    // Given
    const tasksDir = path.join(testDir, '.takt', 'tasks');
    expect(fs.existsSync(tasksDir)).toBe(false);

    // When
    await saveTaskFile(testDir, 'Task content');

    // Then
    expect(fs.existsSync(tasksDir)).toBe(true);
  });

  it('should include piece in YAML when specified', async () => {
    // When
    const filePath = await saveTaskFile(testDir, 'Task', { piece: 'review' });

    // Then
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('piece: review');
  });

  it('should include issue number in YAML when specified', async () => {
    // When
    const filePath = await saveTaskFile(testDir, 'Task', { issue: 42 });

    // Then
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('issue: 42');
  });

  it('should include worktree in YAML when specified', async () => {
    // When
    const filePath = await saveTaskFile(testDir, 'Task', { worktree: true });

    // Then
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('worktree: true');
  });

  it('should include branch in YAML when specified', async () => {
    // When
    const filePath = await saveTaskFile(testDir, 'Task', { branch: 'feat/my-branch' });

    // Then
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('branch: feat/my-branch');
  });

  it('should not include optional fields when not specified', async () => {
    // When
    const filePath = await saveTaskFile(testDir, 'Simple task');

    // Then
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).not.toContain('piece:');
    expect(content).not.toContain('issue:');
    expect(content).not.toContain('worktree:');
    expect(content).not.toContain('branch:');
    expect(content).not.toContain('auto_pr:');
  });

  it('should include auto_pr in YAML when specified', async () => {
    // When
    const filePath = await saveTaskFile(testDir, 'Task', { autoPr: true });

    // Then
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('auto_pr: true');
  });

  it('should include auto_pr: false in YAML when specified as false', async () => {
    // When
    const filePath = await saveTaskFile(testDir, 'Task', { autoPr: false });

    // Then
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('auto_pr: false');
  });

  it('should use first line for filename generation', async () => {
    // When
    await saveTaskFile(testDir, 'First line\nSecond line');

    // Then
    expect(mockSummarizeTaskName).toHaveBeenCalledWith('First line', { cwd: testDir });
  });

  it('should handle duplicate filenames with counter', async () => {
    // Given: first file already exists
    await saveTaskFile(testDir, 'Task 1');

    // When: second file with same slug
    const filePath = await saveTaskFile(testDir, 'Task 2');

    // Then
    expect(path.basename(filePath)).toBe('test-task-1.yaml');
  });
});

describe('saveTaskFromInteractive', () => {
  it('should save task with worktree settings when user confirms worktree', async () => {
    // Given: user confirms worktree, accepts defaults, confirms auto-PR
    mockConfirm.mockResolvedValueOnce(true);   // Create worktree? → Yes
    mockPromptInput.mockResolvedValueOnce('');  // Worktree path → auto
    mockPromptInput.mockResolvedValueOnce('');  // Branch name → auto
    mockConfirm.mockResolvedValueOnce(true);   // Auto-create PR? → Yes

    // When
    await saveTaskFromInteractive(testDir, 'Task content');

    // Then
    expect(mockSuccess).toHaveBeenCalledWith('Task created: test-task.yaml');
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('Path:'));
    const tasksDir = path.join(testDir, '.takt', 'tasks');
    const files = fs.readdirSync(tasksDir);
    const content = fs.readFileSync(path.join(tasksDir, files[0]!), 'utf-8');
    expect(content).toContain('worktree: true');
    expect(content).toContain('auto_pr: true');
  });

  it('should save task without worktree settings when user declines worktree', async () => {
    // Given: user declines worktree
    mockConfirm.mockResolvedValueOnce(false);  // Create worktree? → No

    // When
    await saveTaskFromInteractive(testDir, 'Task content');

    // Then
    expect(mockSuccess).toHaveBeenCalledWith('Task created: test-task.yaml');
    const tasksDir = path.join(testDir, '.takt', 'tasks');
    const files = fs.readdirSync(tasksDir);
    const content = fs.readFileSync(path.join(tasksDir, files[0]!), 'utf-8');
    expect(content).not.toContain('worktree:');
    expect(content).not.toContain('branch:');
    expect(content).not.toContain('auto_pr:');
  });

  it('should save custom worktree path and branch when specified', async () => {
    // Given: user specifies custom path and branch
    mockConfirm.mockResolvedValueOnce(true);              // Create worktree? → Yes
    mockPromptInput.mockResolvedValueOnce('/custom/path'); // Worktree path
    mockPromptInput.mockResolvedValueOnce('feat/branch');  // Branch name
    mockConfirm.mockResolvedValueOnce(false);              // Auto-create PR? → No

    // When
    await saveTaskFromInteractive(testDir, 'Task content');

    // Then
    const tasksDir = path.join(testDir, '.takt', 'tasks');
    const files = fs.readdirSync(tasksDir);
    const content = fs.readFileSync(path.join(tasksDir, files[0]!), 'utf-8');
    expect(content).toContain('worktree: /custom/path');
    expect(content).toContain('branch: feat/branch');
    expect(content).toContain('auto_pr: false');
  });

  it('should display worktree/branch/auto-PR info when settings are provided', async () => {
    // Given
    mockConfirm.mockResolvedValueOnce(true);              // Create worktree? → Yes
    mockPromptInput.mockResolvedValueOnce('/my/path');     // Worktree path
    mockPromptInput.mockResolvedValueOnce('my-branch');    // Branch name
    mockConfirm.mockResolvedValueOnce(true);               // Auto-create PR? → Yes

    // When
    await saveTaskFromInteractive(testDir, 'Task content');

    // Then
    expect(mockInfo).toHaveBeenCalledWith('  Worktree: /my/path');
    expect(mockInfo).toHaveBeenCalledWith('  Branch: my-branch');
    expect(mockInfo).toHaveBeenCalledWith('  Auto-PR: yes');
  });

  it('should display piece info when specified', async () => {
    // Given
    mockConfirm.mockResolvedValueOnce(false);  // Create worktree? → No

    // When
    await saveTaskFromInteractive(testDir, 'Task content', 'review');

    // Then
    expect(mockInfo).toHaveBeenCalledWith('  Piece: review');
  });

  it('should include piece in saved YAML', async () => {
    // Given
    mockConfirm.mockResolvedValueOnce(false);  // Create worktree? → No

    // When
    await saveTaskFromInteractive(testDir, 'Task content', 'custom');

    // Then
    const tasksDir = path.join(testDir, '.takt', 'tasks');
    const files = fs.readdirSync(tasksDir);
    expect(files.length).toBe(1);
    const content = fs.readFileSync(path.join(tasksDir, files[0]!), 'utf-8');
    expect(content).toContain('piece: custom');
  });

  it('should not display piece info when not specified', async () => {
    // Given
    mockConfirm.mockResolvedValueOnce(false);  // Create worktree? → No

    // When
    await saveTaskFromInteractive(testDir, 'Task content');

    // Then
    const pieceInfoCalls = mockInfo.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('Piece:')
    );
    expect(pieceInfoCalls.length).toBe(0);
  });

  it('should display auto worktree info when no custom path', async () => {
    // Given
    mockConfirm.mockResolvedValueOnce(true);   // Create worktree? → Yes
    mockPromptInput.mockResolvedValueOnce('');  // Worktree path → auto
    mockPromptInput.mockResolvedValueOnce('');  // Branch name → auto
    mockConfirm.mockResolvedValueOnce(true);   // Auto-create PR? → Yes

    // When
    await saveTaskFromInteractive(testDir, 'Task content');

    // Then
    expect(mockInfo).toHaveBeenCalledWith('  Worktree: auto');
  });
});
