import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

const mockCheckCliStatus = vi.fn();
const mockFetchPrReviewComments = vi.fn();
const mockFetchIssue = vi.fn();
const mockFetch = vi.fn<typeof fetch>();

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    execFileSync: vi.fn((file: string, args: readonly string[], options: object) => {
      if (file === 'gh' && args[0] === 'auth' && args[1] === 'token') return 'test-credential\n';
      return original.execFileSync(file, args, options);
    }),
  };
});

vi.mock('../features/interactive/index.js', () => ({
  interactiveMode: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  promptInput: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  success: vi.fn(),
  info: vi.fn(),
  blankLine: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  withProgress: vi.fn(async (_start, _done, operation) => operation()),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../features/tasks/execute/selectAndExecute.js', () => ({
  determineWorkflow: vi.fn(),
}));

vi.mock('../infra/task/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  summarizeTaskName: vi.fn().mockResolvedValue('test-task'),
  getCurrentBranch: vi.fn().mockReturnValue('main'),
}));

vi.mock('../infra/task/clone-base-branch.js', () => ({
  branchExists: vi.fn(),
  createBaseBranchIfMissing: vi.fn().mockReturnValue({ branch: 'main', created: false }),
  localBranchExists: vi.fn(),
  remoteBranchExists: vi.fn(),
  localBranchExistsAbortable: vi.fn(),
  remoteBranchExistsAbortable: vi.fn(),
  branchExistsAbortable: vi.fn(),
  resolveBaseBranch: vi.fn().mockReturnValue({ branch: 'main' }),
  resolveBaseBranchAbortable: vi.fn().mockResolvedValue({ branch: 'main' }),
}));

const mockIsIssueReference = vi.fn((s: string) => /^#\d+$/.test(s));
const mockParseIssueNumbers = vi.fn((args: string[]) => {
  const numbers: number[] = [];
  for (const arg of args) {
    const match = arg.match(/^#(\d+)$/);
    if (match?.[1]) {
      numbers.push(Number.parseInt(match[1], 10));
    }
  }
  return numbers;
});
const mockFormatPrReviewAsTask = vi.fn();

vi.mock('../infra/git/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../infra/git/index.js')>();
  const { GitHubProvider } = await import('../infra/github/GitHubProvider.js');
  const provider = Object.assign(new GitHubProvider(), {
    createIssue: vi.fn(),
    checkCliStatus: (...args: unknown[]) => mockCheckCliStatus(...args),
    fetchPrReviewComments: (...args: unknown[]) => mockFetchPrReviewComments(...args),
    fetchIssue: (...args: unknown[]) => mockFetchIssue(...args),
  });
  return {
    ...original,
    getGitProvider: () => provider,
    isIssueReference: (task: string) => mockIsIssueReference(task),
    parseIssueNumbers: (args: string[]) => mockParseIssueNumbers(args),
    formatPrReviewAsTask: (...args: unknown[]) => mockFormatPrReviewAsTask(...args),
  };
});

import { interactiveMode } from '../features/interactive/index.js';
import { promptInput, confirm } from '../shared/prompt/index.js';
import { error, info, warn } from '../shared/ui/index.js';
import { determineWorkflow } from '../features/tasks/execute/selectAndExecute.js';
import { addTask } from '../features/tasks/index.js';
import { getCurrentBranch } from '../infra/task/index.js';
import { branchExists } from '../infra/task/clone-base-branch.js';
import type { PrReviewData } from '../infra/git/index.js';
import { formatPrReviewAsTask } from '../infra/git/format.js';

const mockInteractiveMode = vi.mocked(interactiveMode);
const mockPromptInput = vi.mocked(promptInput);
const mockConfirm = vi.mocked(confirm);
const mockInfo = vi.mocked(info);
const mockError = vi.mocked(error);
const mockDetermineWorkflow = vi.mocked(determineWorkflow);
const mockGetCurrentBranch = vi.mocked(getCurrentBranch);
const mockBranchExists = vi.mocked(branchExists);

let testDir: string;

function loadTasks(dir: string): { tasks: Array<Record<string, unknown>> } {
  const raw = fs.readFileSync(path.join(dir, '.takt', 'tasks.yaml'), 'utf-8');
  return parseYaml(raw) as { tasks: Array<Record<string, unknown>> };
}

function addTaskWithPrOption(cwd: string, task: string, prNumber: number): Promise<void> {
  return addTask(cwd, task, { prNumber });
}

function createMockPrReview(overrides: Partial<PrReviewData & { baseRefName?: string }> = {}): PrReviewData {
  return {
    number: 456,
    title: 'Fix auth bug',
    body: 'PR description',
    url: 'https://github.com/org/repo/pull/456',
    headRefName: 'feature/fix-auth-bug',
    comments: [{ author: 'commenter', body: 'Please update tests' }],
    reviews: [{ author: 'reviewer', body: 'Fix null check' }],
    files: ['src/auth.ts'],
    ...overrides,
  } as PrReviewData;
}

beforeEach(() => {
  vi.clearAllMocks();
  testDir = fs.mkdtempSync(path.join(tmpdir(), 'takt-test-'));
  mockDetermineWorkflow.mockResolvedValue('default');
  mockConfirm.mockResolvedValue(false);
  mockGetCurrentBranch.mockReturnValue('main');
  mockBranchExists.mockReturnValue(true);
  mockCheckCliStatus.mockReturnValue({ available: true });
  mockFormatPrReviewAsTask.mockImplementation(formatPrReviewAsTask);
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }
});

describe('addTask', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
  const x = 'https://github.com/user-attachments/assets/x';
  const y = 'https://github.com/user-attachments/assets/y';
  const z = 'https://github.com/user-attachments/assets/z';

  function respondWithPng(): Response {
    return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } });
  }

  function readRegisteredImageTask(): { task: Record<string, unknown>; taskDir: string; order: string } {
    const tasks = loadTasks(testDir).tasks;
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    const taskDir = path.join(testDir, String(task.task_dir));
    return { task, taskDir, order: fs.readFileSync(path.join(taskDir, 'order.md'), 'utf-8') };
  }

  function expectImageReference(order: string, syntax: string, number: number): void {
    const escaped = syntax.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(order).toMatch(new RegExp(`${escaped}\\s*\\[Image #${number}\\]`));
  }

  it('saves Markdown and HTML PR images in order with original syntax and PR settings', async () => {
    const markdown = `![a](${x})`;
    const html = `<img src="${y}">`;
    mockFetchPrReviewComments.mockReturnValue(createMockPrReview({
      body: markdown, baseRefName: 'release/main', comments: [],
      reviews: [{ author: 'reviewer', body: html, path: 'src/auth.ts', line: 3, threadState: 'active' }],
    }));
    mockFetch.mockImplementation(async () => respondWithPng());

    await addTask(testDir, undefined, { prNumber: 456 });

    const { task, taskDir, order } = readRegisteredImageTask();
    expect(fs.readdirSync(path.join(taskDir, 'attachments'))).toEqual(['image-1.png', 'image-2.png']);
    for (const name of ['image-1.png', 'image-2.png']) expect(fs.readFileSync(path.join(taskDir, 'attachments', name))).toEqual(png);
    expectImageReference(order, markdown, 1);
    expectImageReference(order, html, 2);
    expect(order).toContain('## 添付画像');
    expect(order).toContain('- [Image #1]: `attachments/image-1.png`');
    expect(order).toContain('- [Image #2]: `attachments/image-2.png`');
    expect(task).toMatchObject({ branch: 'feature/fix-auth-bug', base_branch: 'release/main', pr_number: 456, source: 'pr_review', worktree: true, auto_pr: false, should_publish_branch_to_origin: true });
  });

  it('extracts every PR body kind in formatted appearance order and ignores metadata images', async () => {
    const urls = ['body', 'summary', 'active', 'outdated', 'resolved', 'conversation'].map((name) => `https://github.com/user-attachments/assets/${name}`);
    const image = (index: number) => `![a](${urls[index]})`;
    mockFetchPrReviewComments.mockReturnValue(createMockPrReview({
      title: `title ![ignored](${z})`, body: image(0),
      reviews: [
        { author: 'resolved', body: image(4), path: 'resolved.ts', threadState: 'resolved' },
        { author: 'active', body: image(2), path: 'active.ts', threadState: 'active' },
        { author: 'summary', body: image(1) },
        { author: 'outdated', body: image(3), path: 'outdated.ts', threadState: 'outdated-unresolved' },
      ],
      comments: [{ author: 'conversation', body: image(5) }], files: [`![ignored](${z})`],
    }));
    mockFetch.mockImplementation(async () => respondWithPng());

    await addTask(testDir, undefined, { prNumber: 456 });

    const { taskDir, order } = readRegisteredImageTask();
    expect(mockFetch.mock.calls.map(([requestedUrl]) => String(requestedUrl))).toEqual(urls);
    expect(fs.readdirSync(path.join(taskDir, 'attachments'))).toHaveLength(6);
    urls.forEach((_url, index) => expectImageReference(order, image(index), index + 1));
  });

  it('reuses duplicate image numbers and skips failed images without gaps', async () => {
    const failed = `![z](${z})`;
    const first = `![x](${x})`;
    const second = `![y](${y})`;
    mockFetchPrReviewComments.mockReturnValue(createMockPrReview({ body: [failed, failed, first, first, second].join('\n') }));
    mockFetch.mockImplementation(async (requestedUrl) => String(requestedUrl) === z
      ? new Response(null, { status: 404 }) : respondWithPng());

    await addTask(testDir, undefined, { prNumber: 456 });

    const { taskDir, order } = readRegisteredImageTask();
    expect(mockFetch.mock.calls.map(([requestedUrl]) => String(requestedUrl))).toEqual([z, x, y]);
    expect(fs.readdirSync(path.join(taskDir, 'attachments'))).toEqual(['image-1.png', 'image-2.png']);
    expect(order.split('\n').filter((line) => line.startsWith(failed))).toEqual([failed, failed]);
    const repeatedLines = order.split('\n').filter((line) => line.startsWith(first));
    expect(repeatedLines).toHaveLength(2);
    repeatedLines.forEach((line) => expectImageReference(line, first, 1));
    expectImageReference(order, second, 2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([401, 404, 'network', 'invalid'] as const)('registers an image-only PR even when its image fails with %s', async (failure) => {
    const markdown = `![a](${x})`;
    mockFetchPrReviewComments.mockReturnValue(createMockPrReview({ body: markdown, reviews: [], comments: [] }));
    mockFetch.mockImplementation(async () => {
      if (failure === 'network') throw new TypeError('network unavailable');
      if (failure === 'invalid') return new Response('login', { headers: { 'content-type': 'text/html' } });
      return new Response(null, { status: failure });
    });

    await addTask(testDir, undefined, { prNumber: 456 });

    const { taskDir, order } = readRegisteredImageTask();
    expect(order.split('\n')).toContain(markdown);
    expect(fs.existsSync(path.join(taskDir, 'attachments'))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('ignores external images and does not save a GitHub response with a non-image Content-Type', async () => {
    const external = '![external](https://example.com/a.png)';
    const invalid = `![invalid](${x})`;
    mockFetchPrReviewComments.mockReturnValue(createMockPrReview({ body: `${external}\n${invalid}` }));
    mockFetch.mockResolvedValueOnce(new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }));

    await addTask(testDir, undefined, { prNumber: 456 });

    const { taskDir, order } = readRegisteredImageTask();
    expect(mockFetch.mock.calls.map(([requestedUrl]) => String(requestedUrl))).toEqual([x]);
    expect(order.split('\n')).toContain(external);
    expect(order.split('\n')).toContain(invalid);
    expect(fs.existsSync(path.join(taskDir, 'attachments'))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('saves Issue body and comment images through the issue-reference route', async () => {
    const markdown = `![a](${x})`;
    const html = `<img src="${y}">`;
    mockFetchIssue.mockReturnValue({
      number: 792, title: `issue ![ignored](${z})`, body: markdown,
      labels: [`![ignored](${z})`], comments: [{ author: 'commenter', body: html }],
    });
    mockFetch.mockImplementation(async () => respondWithPng());

    await addTask(testDir, '#792');

    const { task, taskDir, order } = readRegisteredImageTask();
    expect(task.issue).toBe(792);
    expect(mockFetch.mock.calls.map(([requestedUrl]) => String(requestedUrl))).toEqual([x, y]);
    expect(fs.readFileSync(path.join(taskDir, 'attachments', 'image-1.png'))).toEqual(png);
    expect(fs.readFileSync(path.join(taskDir, 'attachments', 'image-2.png'))).toEqual(png);
    expectImageReference(order, markdown, 1);
    expectImageReference(order, html, 2);
    expect(order).toContain('## 添付画像');
  });

  it('keeps ordinary task input unchanged without downloading its image syntax', async () => {
    const taskContent = `通常の入力\n![a](${x})\n[Image #9]`;

    await addTask(testDir, taskContent);

    const { taskDir, order } = readRegisteredImageTask();
    expect(order).toBe(taskContent);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(taskDir, 'attachments'))).toBe(false);
  });

  it('registers an Issue when its image cannot be downloaded', async () => {
    const markdown = `![a](${x})`;
    mockFetchIssue.mockReturnValue({ number: 792, title: 'Issue image', body: markdown, labels: [], comments: [] });
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));

    await addTask(testDir, '#792');

    const { task, taskDir, order } = readRegisteredImageTask();
    expect(task.issue).toBe(792);
    expect(order.split('\n')).toContain(markdown);
    expect(fs.existsSync(path.join(taskDir, 'attachments'))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps existing text placeholders while numbering only downloaded images', async () => {
    const markdown = `![a](${x})`;
    mockFetchPrReviewComments.mockReturnValue(createMockPrReview({ body: `[Image #9]\n${markdown}` }));
    mockFetch.mockResolvedValueOnce(respondWithPng());

    await addTask(testDir, undefined, { prNumber: 456 });

    const { taskDir, order } = readRegisteredImageTask();
    expect(order.split('\n')).toContain('[Image #9]');
    expectImageReference(order, markdown, 1);
    expect(fs.readdirSync(path.join(taskDir, 'attachments'))).toEqual(['image-1.png']);
  });

  function readOrderContent(dir: string, taskDir: unknown): string {
    return fs.readFileSync(path.join(dir, String(taskDir), 'order.md'), 'utf-8');
  }

  it('should show usage and exit when task is missing', async () => {
    await addTask(testDir);

    expect(mockInfo).toHaveBeenCalled();
    expect(mockDetermineWorkflow).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  });

  it('should show usage and exit when task is blank', async () => {
    await addTask(testDir, '   ');

    expect(mockInfo).toHaveBeenCalled();
    expect(mockDetermineWorkflow).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  });

  it('should save plain text task without interactive mode', async () => {
    await addTask(testDir, '  JWT認証を実装する  ');

    expect(mockInteractiveMode).not.toHaveBeenCalled();
    const task = loadTasks(testDir).tasks[0]!;
    expect(task.content).toBeUndefined();
    expect(task.task_dir).toBeTypeOf('string');
    expect(readOrderContent(testDir, task.task_dir)).toContain('JWT認証を実装する');
    expect(task.workflow).toBe('default');
    expect(task.worktree).toBe(true);
  });

  it('should include worktree settings when enabled', async () => {
    mockConfirm.mockResolvedValue(true);
    mockPromptInput.mockResolvedValueOnce('/custom/path').mockResolvedValueOnce('feat/branch');

    await addTask(testDir, 'Task content');

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.worktree).toBe('/custom/path');
    expect(task.branch).toBe('feat/branch');
    expect(task.auto_pr).toBe(true);
  });

  it('should set base_branch when current branch is not main/master and user confirms', async () => {
    mockGetCurrentBranch.mockReturnValue('feat/awesome');
    mockConfirm.mockResolvedValueOnce(true);
    mockPromptInput.mockResolvedValueOnce('').mockResolvedValueOnce('');
    mockConfirm.mockResolvedValueOnce(false);

    await addTask(testDir, 'Task content');

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.base_branch).toBe('feat/awesome');
  });

  it('should not set base_branch when current branch prompt is declined', async () => {
    mockGetCurrentBranch.mockReturnValue('feat/awesome');
    mockConfirm.mockResolvedValueOnce(false);
    mockPromptInput.mockResolvedValueOnce('').mockResolvedValueOnce('');

    await addTask(testDir, 'Task content');

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.base_branch).toBeUndefined();
    expect(mockBranchExists).not.toHaveBeenCalled();
  });

  it('should skip base branch prompt when current branch detection fails', async () => {
    mockGetCurrentBranch.mockImplementationOnce(() => {
      throw new Error('not a git repository');
    });

    await addTask(testDir, 'Task content');

    expect(mockConfirm).toHaveBeenCalled();
    const task = loadTasks(testDir).tasks[0]!;
    expect(task.base_branch).toBeUndefined();
  });

  it('should reprompt when base branch does not exist', async () => {
    mockGetCurrentBranch.mockReturnValue('feat/missing');
    mockConfirm.mockResolvedValueOnce(true);
    mockBranchExists.mockReturnValueOnce(false).mockReturnValueOnce(true);
    mockPromptInput
      .mockResolvedValueOnce('develop')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');
    mockConfirm.mockResolvedValueOnce(false);

    await addTask(testDir, 'Task content');

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.base_branch).toBe('develop');
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('feat/missing'));
  });

  it('should create task from issue reference without interactive mode', async () => {
    mockFetchIssue.mockReturnValue({ number: 99, title: 'Fix login timeout', body: '', labels: [], comments: [] });

    await addTask(testDir, '#99');

    expect(mockInteractiveMode).not.toHaveBeenCalled();
    expect(mockFetchIssue).toHaveBeenCalledWith(99, testDir);
    const task = loadTasks(testDir).tasks[0]!;
    expect(task.content).toBeUndefined();
    expect(readOrderContent(testDir, task.task_dir)).toContain('Fix login timeout');
    expect(task.issue).toBe(99);
  });

  it('should create task from PR review comments with PR-specific task settings', async () => {
    const prReview = createMockPrReview();
    const formattedTask = '## PR #456 Review Comments: Fix auth bug';
    mockFetchPrReviewComments.mockReturnValue(prReview);
    mockFormatPrReviewAsTask.mockReturnValue(formattedTask);

    await addTaskWithPrOption(testDir, 'placeholder', 456);

    expect(mockCheckCliStatus).toHaveBeenCalledWith(testDir);
    expect(mockCheckCliStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mockFetchPrReviewComments.mock.invocationCallOrder[0]!,
    );
    expect(mockFetchPrReviewComments).toHaveBeenCalledWith(456, testDir);
    expect(mockIsIssueReference).not.toHaveBeenCalled();
    expect(mockParseIssueNumbers).not.toHaveBeenCalled();
    expect(mockFetchIssue).not.toHaveBeenCalled();
    expect(mockPromptInput).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDetermineWorkflow).toHaveBeenCalledTimes(1);
    const task = loadTasks(testDir).tasks[0]!;
    expect(task.content).toBeUndefined();
    expect(task.branch).toBe('feature/fix-auth-bug');
    expect(task.auto_pr).toBe(false);
    expect(task.worktree).toBe(true);
    expect(task.should_publish_branch_to_origin).toBe(true);
    expect(task.draft_pr).toBeUndefined();
    expect(task.source).toBe('pr_review');
    expect(task.pr_number).toBe(456);
    expect(readOrderContent(testDir, task.task_dir)).toContain(formattedTask);
  });

  it('should store PR base_ref as base_branch when adding with --pr', async () => {
    const prReview = createMockPrReview({ baseRefName: 'release/main' });
    const formattedTask = '## PR #456 Review Comments: Fix auth bug';
    mockFetchPrReviewComments.mockReturnValue(prReview);
    mockFormatPrReviewAsTask.mockReturnValue(formattedTask);

    await addTaskWithPrOption(testDir, 'placeholder', 456);

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.base_branch).toBe('release/main');
    expect(task.should_publish_branch_to_origin).toBe(true);
  });

  it('should not create a PR task when PR has no review comments', async () => {
    const prReview = createMockPrReview({ comments: [], reviews: [] });
    mockFetchPrReviewComments.mockReturnValue(prReview);

    await addTaskWithPrOption(testDir, 'placeholder', 456);

    expect(mockCheckCliStatus).toHaveBeenCalled();
    expect(mockFetchPrReviewComments).toHaveBeenCalledWith(456, testDir);
    expect(mockFormatPrReviewAsTask).not.toHaveBeenCalled();
    expect(mockDetermineWorkflow).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalled();
    expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  });

  it('should show error and not create task when fetchPrReviewComments throws', async () => {
    mockFetchPrReviewComments.mockImplementation(() => { throw new Error('network timeout'); });

    await addTaskWithPrOption(testDir, 'placeholder', 456);

    expect(mockCheckCliStatus).toHaveBeenCalled();
    expect(mockFetchPrReviewComments).toHaveBeenCalledWith(456, testDir);
    expect(mockFormatPrReviewAsTask).not.toHaveBeenCalled();
    expect(mockDetermineWorkflow).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('network timeout'));
    expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  });

  it('should not create a PR task when CLI is unavailable', async () => {
    mockCheckCliStatus.mockReturnValue({ available: false, error: 'gh CLI is not available' });

    await addTaskWithPrOption(testDir, 'placeholder', 456);

    expect(mockFetchPrReviewComments).not.toHaveBeenCalled();
    expect(mockFormatPrReviewAsTask).not.toHaveBeenCalled();
    expect(mockDetermineWorkflow).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalled();
    expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  });

  it('should not perform issue parsing when PR task text looks like issue reference', async () => {
    const prReview = createMockPrReview();
    const formattedTask = '## PR #456 Review Comments: Fix auth bug';
    mockFetchPrReviewComments.mockReturnValue(prReview);
    mockFormatPrReviewAsTask.mockReturnValue(formattedTask);

    await addTaskWithPrOption(testDir, '#99', 456);

    expect(mockIsIssueReference).not.toHaveBeenCalled();

    expect(mockParseIssueNumbers).not.toHaveBeenCalled();
    expect(mockFetchIssue).not.toHaveBeenCalled();
    expect(mockCheckCliStatus).toHaveBeenCalled();
    expect(mockFetchPrReviewComments).toHaveBeenCalledWith(456, testDir);
    const task = loadTasks(testDir).tasks[0]!;
    expect(task.content).toBeUndefined();
    expect(task.branch).toBe('feature/fix-auth-bug');
    expect(task.auto_pr).toBe(false);
  });

  it('should not create task when workflow selection is cancelled', async () => {
    mockDetermineWorkflow.mockResolvedValue(null);

    await addTask(testDir, 'Task content');

    expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  });

  it('should not save PR task when workflow selection is cancelled', async () => {
    const prReview = createMockPrReview();
    const formattedTask = '## PR #456 Review Comments: Fix auth bug';
    mockDetermineWorkflow.mockResolvedValue(null);
    mockFetchPrReviewComments.mockReturnValue(prReview);
    mockFormatPrReviewAsTask.mockReturnValue(formattedTask);

    await addTaskWithPrOption(testDir, 'placeholder', 456);

    expect(mockCheckCliStatus).toHaveBeenCalled();
    expect(mockFetchPrReviewComments).toHaveBeenCalledWith(456, testDir);
    expect(mockDetermineWorkflow).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  });
});
