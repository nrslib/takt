import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

const { mockCreateIssue } = vi.hoisted(() => ({
  mockCreateIssue: vi.fn(),
}));

vi.mock('../infra/task/summarize.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  summarizeTaskName: vi.fn().mockImplementation((content: string) => {
    const slug = content.split('\n')[0]!
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30)
      .replace(/-+$/, '');
    return Promise.resolve(slug || 'task');
  }),
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

vi.mock('../infra/task/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCurrentBranch: vi.fn().mockReturnValue('main'),
  branchExists: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/git/index.js', () => ({
  getGitProvider: () => ({
    createIssue: (...args: unknown[]) => mockCreateIssue(...args),
  }),
}));

import { success, info } from '../shared/ui/index.js';
import { confirm, promptInput } from '../shared/prompt/index.js';
import { createIssueAndSaveTask, saveTaskFile, saveTaskFromInteractive } from '../features/tasks/add/index.js';
import { getCurrentBranch, branchExists } from '../infra/task/index.js';
import { summarizeTaskName } from '../infra/task/summarize.js';

const mockSuccess = vi.mocked(success);
const mockInfo = vi.mocked(info);
const mockConfirm = vi.mocked(confirm);
const mockPromptInput = vi.mocked(promptInput);
const mockGetCurrentBranch = vi.mocked(getCurrentBranch);
const mockBranchExists = vi.mocked(branchExists);
const mockSummarizeTaskName = vi.mocked(summarizeTaskName);

let testDir: string;

function loadTasks(testDir: string): { tasks: Array<Record<string, unknown>> } {
  const raw = fs.readFileSync(path.join(testDir, '.takt', 'tasks.yaml'), 'utf-8');
  return parseYaml(raw) as { tasks: Array<Record<string, unknown>> };
}

function expectNoTaskArtifacts(testDir: string): void {
  expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  expect(fs.existsSync(path.join(testDir, '.takt', 'tasks'))).toBe(false);
}

interface TestTaskAttachment {
  placeholder: string;
  tempPath: string;
  fileName: string;
}

function createTempAttachment(root: string, fileName: string, content: string): TestTaskAttachment {
  const sourceDir = path.join(root, 'tmp-attachments');
  fs.mkdirSync(sourceDir, { recursive: true });
  const tempPath = path.join(sourceDir, fileName);
  fs.writeFileSync(tempPath, content, 'utf-8');
  return {
    placeholder: '[Image #1]',
    tempPath,
    fileName,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-02-10T04:40:00.000Z'));
  testDir = fs.mkdtempSync(path.join(tmpdir(), 'takt-test-save-'));
  mockGetCurrentBranch.mockReturnValue('main');
  mockBranchExists.mockReturnValue(true);
  mockCreateIssue.mockReturnValue({ success: true, url: 'https://github.com/owner/repo/issues/42' });
});

afterEach(() => {
  vi.useRealTimers();
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }
});

describe('saveTaskFile', () => {
  it('should append task to tasks.yaml', async () => {
    const created = await saveTaskFile(testDir, 'Implement feature X\nDetails here');

    expect(created.taskName).toContain('implement-feature-x');
    expect(created.tasksFile).toBe(path.join(testDir, '.takt', 'tasks.yaml'));
    expect(fs.existsSync(created.tasksFile)).toBe(true);

    const tasks = loadTasks(testDir).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.content).toBeUndefined();
    expect(tasks[0]?.task_dir).toBeTypeOf('string');
    expect(tasks[0]?.slug).toBeTypeOf('string');
    expect(tasks[0]?.summary).toBe('Implement feature X');
    const taskDir = path.join(testDir, String(tasks[0]?.task_dir));
    expect(fs.existsSync(path.join(taskDir, 'order.md'))).toBe(true);
    expect(fs.readFileSync(path.join(taskDir, 'order.md'), 'utf-8')).toContain('Implement feature X');
  });

  it('should include optional fields', async () => {
    await saveTaskFile(testDir, 'Task', {
      workflow: 'review',
      issue: 42,
      worktree: true,
      branch: 'feat/my-branch',
      autoPr: false,
    });

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.workflow).toBe('review');
    expect(task.issue).toBe(42);
    expect(task.worktree).toBe(true);
    expect(task.branch).toBe('feat/my-branch');
    expect(task.auto_pr).toBe(false);
    expect(task.task_dir).toBeTypeOf('string');
  });

  it('should persist workflow key', async () => {
    await saveTaskFile(testDir, 'Task', {
      workflow: 'review',
    });

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.workflow).toBe('review');
  });

  it('should accept canonical workflow option and persist workflow key', async () => {
    await saveTaskFile(testDir, 'Task', {
      workflow: 'review',
    });

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.workflow).toBe('review');
  });

  it('should persist base_branch when it is provided', async () => {
    await saveTaskFile(testDir, 'Task', {
      workflow: 'review',
      issue: 42,
      worktree: true,
      branch: 'feature/bugfix',
      baseBranch: 'release/main',
    });

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.base_branch).toBe('release/main');
  });

  it('should persist draft_pr when draftPr is true', async () => {
    await saveTaskFile(testDir, 'Draft task', {
      autoPr: true,
      draftPr: true,
    });

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.auto_pr).toBe(true);
    expect(task.draft_pr).toBe(true);
  });

  it('should persist managed_pr when managedPr is true', async () => {
    const options = {
      worktree: true,
      autoPr: true,
      managedPr: true,
    };

    await saveTaskFile(testDir, 'Managed PR task', options);

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.auto_pr).toBe(true);
    expect(task.managed_pr).toBe(true);
  });

  it('should reject managed_pr when autoPr is false', async () => {
    await expect(saveTaskFile(testDir, 'Managed PR task', {
      worktree: true,
      managedPr: true,
    })).rejects.toThrow('managed_pr requires auto_pr to be true');
    expect(mockSummarizeTaskName).not.toHaveBeenCalled();
    expectNoTaskArtifacts(testDir);
  });

  it('should reject managed_pr when worktree is disabled', async () => {
    await expect(saveTaskFile(testDir, 'Managed PR task', {
      autoPr: true,
      managedPr: true,
    })).rejects.toThrow('managed_pr requires worktree to be enabled');
    expect(mockSummarizeTaskName).not.toHaveBeenCalled();
    expectNoTaskArtifacts(testDir);
  });

  it('should remove created task dir when runner.addTask fails after writing order.md', async () => {
    fs.mkdirSync(path.join(testDir, '.takt'), { recursive: true });
    fs.writeFileSync(path.join(testDir, '.takt', 'tasks.yaml'), 'tasks: [broken', 'utf-8');

    await expect(saveTaskFile(testDir, 'Broken task config')).rejects.toThrow('Invalid tasks.yaml');

    expect(fs.readFileSync(path.join(testDir, '.takt', 'tasks.yaml'), 'utf-8')).toBe('tasks: [broken');
    expect(fs.existsSync(path.join(testDir, '.takt', 'tasks'))).toBe(false);
  });

  it('should persist should_publish_branch_to_origin when shouldPublishBranchToOrigin is true', async () => {
    await saveTaskFile(testDir, 'PR fix task', {
      worktree: true,
      branch: 'takt/1/fix',
      autoPr: false,
      shouldPublishBranchToOrigin: true,
    });

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.should_publish_branch_to_origin).toBe(true);
    expect(task.worktree).toBe(true);
    expect(task.branch).toBe('takt/1/fix');
    expect(task.auto_pr).toBe(false);
  });

  it('should generate unique names on duplicates', async () => {
    const first = await saveTaskFile(testDir, 'Same title');
    const second = await saveTaskFile(testDir, 'Same title');

    expect(first.taskName).not.toBe(second.taskName);

    const tasks = loadTasks(testDir).tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.task_dir).toBe('.takt/tasks/20260210-044000-same-title');
    expect(tasks[1]?.task_dir).toBe('.takt/tasks/20260210-044000-same-title-2');
    expect(fs.readFileSync(path.join(testDir, String(tasks[0]?.task_dir), 'order.md'), 'utf-8')).toContain('Same title');
    expect(fs.readFileSync(path.join(testDir, String(tasks[1]?.task_dir), 'order.md'), 'utf-8')).toContain('Same title');
  });

  it('should promote image attachments and append relative paths to order.md', async () => {
    const attachment = createTempAttachment(testDir, 'image-1.png', 'png-data');

    await saveTaskFile(testDir, 'Use [Image #1] as the visual reference.', {
      attachments: [attachment],
    });

    const task = loadTasks(testDir).tasks[0]!;
    const taskDir = path.join(testDir, String(task.task_dir));
    const orderContent = fs.readFileSync(path.join(taskDir, 'order.md'), 'utf-8');

    expect(orderContent).toContain('Use [Image #1] as the visual reference.');
    expect(orderContent).toContain('## 添付画像');
    expect(orderContent).toContain('- [Image #1]: `attachments/image-1.png`');
    expect(fs.readFileSync(path.join(taskDir, 'attachments', 'image-1.png'), 'utf-8')).toBe('png-data');
  });

  it('should replace pasted image temp paths in generated task content with task attachment paths', async () => {
    const attachment = createTempAttachment(testDir, 'image-1.png', 'png-data');

    await saveTaskFile(testDir, `Use [Image #1] (\`${attachment.tempPath}\`) as the visual reference.`, {
      attachments: [attachment],
    });

    const task = loadTasks(testDir).tasks[0]!;
    const taskDir = path.join(testDir, String(task.task_dir));
    const orderContent = fs.readFileSync(path.join(taskDir, 'order.md'), 'utf-8');

    expect(orderContent).toContain('Use [Image #1] (`attachments/image-1.png`) as the visual reference.');
    expect(orderContent).not.toContain(attachment.tempPath);
    expect(orderContent).toContain('- [Image #1]: `attachments/image-1.png`');
  });

  it('should wrap bare pasted image temp paths when normalizing generated task content', async () => {
    const attachment = createTempAttachment(testDir, 'image-1.png', 'png-data');

    await saveTaskFile(testDir, `Use the visual reference at ${attachment.tempPath}.`, {
      attachments: [attachment],
    });

    const task = loadTasks(testDir).tasks[0]!;
    const taskDir = path.join(testDir, String(task.task_dir));
    const orderContent = fs.readFileSync(path.join(taskDir, 'order.md'), 'utf-8');

    expect(orderContent).toContain('Use the visual reference at `attachments/image-1.png`.');
    expect(orderContent).not.toContain(attachment.tempPath);
  });

  it('should not create task artifacts when attachment promotion fails', async () => {
    const attachment: TestTaskAttachment = {
      placeholder: '[Image #1]',
      tempPath: path.join(testDir, 'missing-image-1.png'),
      fileName: 'image-1.png',
    };

    await expect(saveTaskFile(testDir, 'Use [Image #1].', {
      attachments: [attachment],
    })).rejects.toThrow();

    expectNoTaskArtifacts(testDir);
  });

  it('should reject symlink attachment tempPath and clean up task artifacts', async () => {
    const sourcePath = path.join(testDir, 'source-image.png');
    const symlinkPath = path.join(testDir, 'linked-image.png');
    fs.writeFileSync(sourcePath, 'png-data', 'utf-8');
    fs.symlinkSync(sourcePath, symlinkPath);

    await expect(saveTaskFile(testDir, 'Use [Image #1].', {
      attachments: [{
        placeholder: '[Image #1]',
        tempPath: symlinkPath,
        fileName: 'image-1.png',
      }],
    })).rejects.toThrow(`Task attachment source must be a regular file: ${symlinkPath}`);

    expectNoTaskArtifacts(testDir);
  });

  it('should reject directory attachment tempPath and clean up task artifacts', async () => {
    const directoryPath = path.join(testDir, 'image-directory');
    fs.mkdirSync(directoryPath);

    await expect(saveTaskFile(testDir, 'Use [Image #1].', {
      attachments: [{
        placeholder: '[Image #1]',
        tempPath: directoryPath,
        fileName: 'image-1.png',
      }],
    })).rejects.toThrow(`Task attachment source must be a regular file: ${directoryPath}`);

    expectNoTaskArtifacts(testDir);
  });
});

describe('saveTaskFromInteractive', () => {
  it('should always save task with worktree settings', async () => {
    mockPromptInput.mockResolvedValueOnce('');
    mockPromptInput.mockResolvedValueOnce('');
    mockConfirm.mockResolvedValueOnce(true);  // auto-create PR?
    mockConfirm.mockResolvedValueOnce(true);  // create as draft?

    await saveTaskFromInteractive(testDir, 'Task content');

    expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining('Task created:'));
    const task = loadTasks(testDir).tasks[0]!;
    expect(task.worktree).toBe(true);
    expect(task.auto_pr).toBe(true);
    expect(task.draft_pr).toBe(true);
  });

  it('should keep worktree enabled even when auto-pr is declined', async () => {
    mockPromptInput.mockResolvedValueOnce('');
    mockPromptInput.mockResolvedValueOnce('');
    mockConfirm.mockResolvedValueOnce(false);

    await saveTaskFromInteractive(testDir, 'Task content');

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.worktree).toBe(true);
    expect(task.branch).toBeUndefined();
    expect(task.auto_pr).toBe(false);
  });

  it('should display workflow info when specified', async () => {
    mockPromptInput.mockResolvedValueOnce('');
    mockPromptInput.mockResolvedValueOnce('');
    mockConfirm.mockResolvedValueOnce(false);

    await saveTaskFromInteractive(testDir, 'Task content', 'review');

    expect(mockInfo).toHaveBeenCalledWith('  Workflow: review');
  });

  it('should record issue number in tasks.yaml when issue option is provided', async () => {
    mockPromptInput.mockResolvedValueOnce('');
    mockPromptInput.mockResolvedValueOnce('');
    mockConfirm.mockResolvedValueOnce(false);

    await saveTaskFromInteractive(testDir, 'Fix login bug', 'default', { issue: 42 });

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.issue).toBe(42);
  });

  it('should record PR review metadata in tasks.yaml when prNumber option is provided', async () => {
    mockPromptInput.mockResolvedValueOnce('');
    mockPromptInput.mockResolvedValueOnce('');
    mockConfirm.mockResolvedValueOnce(false);

    await saveTaskFromInteractive(testDir, 'Fix PR review comments', 'default', { prNumber: 456 });

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.source).toBe('pr_review');
    expect(task.pr_number).toBe(456);
  });

  it('should persist image attachments when saving an interactive task with preset settings', async () => {
    const attachment = createTempAttachment(testDir, 'image-1.png', 'interactive-image');

    await saveTaskFromInteractive(testDir, 'Review [Image #1].', 'default', {
      presetSettings: { worktree: true, autoPr: false, draftPr: false },
      attachments: [attachment],
    });

    const task = loadTasks(testDir).tasks[0]!;
    const taskDir = path.join(testDir, String(task.task_dir));
    const orderContent = fs.readFileSync(path.join(taskDir, 'order.md'), 'utf-8');
    expect(task.workflow).toBe('default');
    expect(task.worktree).toBe(true);
    expect(orderContent).toContain('Review [Image #1].');
    expect(orderContent).toContain('- [Image #1]: `attachments/image-1.png`');
    expect(fs.readFileSync(path.join(taskDir, 'attachments', 'image-1.png'), 'utf-8')).toBe('interactive-image');
  });

  describe('with confirmAtEndMessage', () => {
    it('should not save task when user declines confirmAtEndMessage', async () => {
      mockConfirm.mockResolvedValueOnce(false);

      await saveTaskFromInteractive(testDir, 'Task content', 'default', {
        issue: 42,
        confirmAtEndMessage: 'Add this issue to tasks?',
      });

      expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
    });

    it('should prompt worktree settings after confirming confirmAtEndMessage', async () => {
      mockConfirm.mockResolvedValueOnce(true);
      mockPromptInput.mockResolvedValueOnce('');
      mockPromptInput.mockResolvedValueOnce('');
      mockConfirm.mockResolvedValueOnce(false);

      await saveTaskFromInteractive(testDir, 'Task content', 'default', {
        issue: 42,
        confirmAtEndMessage: 'Add this issue to tasks?',
      });

      expect(mockConfirm).toHaveBeenNthCalledWith(1, 'Add this issue to tasks?', true);
      expect(mockConfirm).toHaveBeenNthCalledWith(2, 'Auto-create PR?', true);
      const task = loadTasks(testDir).tasks[0]!;
      expect(task.issue).toBe(42);
      expect(task.worktree).toBe(true);
    });
  });

  it('should save base_branch when current branch is not main/master and user confirms', async () => {
    mockGetCurrentBranch.mockReturnValue('feature/custom-base');
    mockConfirm.mockResolvedValueOnce(true);
    mockPromptInput.mockResolvedValueOnce('');
    mockPromptInput.mockResolvedValueOnce('');
    mockConfirm.mockResolvedValueOnce(false);

    await saveTaskFromInteractive(testDir, 'Task content');

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.base_branch).toBe('feature/custom-base');
  });
});

describe('createIssueAndSaveTask', () => {
  it('should persist issue task attachments through interactive save', async () => {
    const attachment = createTempAttachment(testDir, 'image-1.png', 'issue-image');
    mockPromptInput.mockResolvedValueOnce('');
    mockPromptInput.mockResolvedValueOnce('');
    mockConfirm.mockResolvedValueOnce(false);

    await createIssueAndSaveTask(testDir, 'Review [Image #1].', 'default', {
      attachments: [attachment],
    });

    expect(mockCreateIssue).toHaveBeenCalledWith(
      { title: 'Review [Image #1].', body: 'Review [Image #1].', labels: undefined },
      testDir,
    );
    const task = loadTasks(testDir).tasks[0]!;
    const taskDir = path.join(testDir, String(task.task_dir));
    const orderContent = fs.readFileSync(path.join(taskDir, 'order.md'), 'utf-8');
    expect(task.issue).toBe(42);
    expect(task.workflow).toBe('default');
    expect(orderContent).toContain('Review [Image #1].');
    expect(orderContent).toContain('- [Image #1]: `attachments/image-1.png`');
    expect(fs.readFileSync(path.join(taskDir, 'attachments', 'image-1.png'), 'utf-8')).toBe('issue-image');
  });
});
