/**
 * Tests for task history context formatting in interactive summary.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPostSummaryActionSelector,
  createSelectActionWithoutExecute,
  formatStepPreviews,
  type InteractiveSummaryUIText,
} from '../features/interactive/interactive-summary.js';
import { buildConversationSummaryPrompt } from '../features/interactive/interactiveApplication.js';
import { getLabelObject } from '../shared/i18n/index.js';

const promptMocks = vi.hoisted(() => ({ select: vi.fn(), confirm: vi.fn() }));
vi.mock('../shared/prompt/tty.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/prompt/tty.js')>()),
  resolveTtyPolicy: () => ({ useTty: true, forceTouchTty: false }),
}));
vi.mock('../shared/prompt/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/prompt/index.js')>()),
  selectOption: promptMocks.select,
  selectOptionWithDefault: promptMocks.select,
  confirmWithCancel: promptMocks.confirm,
}));

beforeEach(() => {
  promptMocks.select.mockReset().mockResolvedValue('save_task');
  promptMocks.confirm.mockReset().mockResolvedValue({ kind: 'value', value: true });
});


import {
  buildSummaryPrompt,
  buildSummaryActionOptions,
  formatTaskHistorySummary,
  type WorkflowContext,
  type SummaryActionLabels,
  type TaskHistorySummaryItem,
} from '../features/interactive/interactive.js';

describe('formatTaskHistorySummary', () => {
  it('returns empty string when history is empty', () => {
    expect(formatTaskHistorySummary([], 'en')).toBe('');
  });

});

describe('buildSummaryPrompt', () => {
  describe.each(['en', 'ja'] as const)('ACP utterance in %s', (lang) => {
    it.each([false, true])('uses explicit ACP source with history=%s and omits an empty utterance', (hasHistory) => {
      const history = hasHistory ? [{ role: 'assistant' as const, content: 'Implement audit logs.' }] : [];
      const note = 'Add audit logs and explain /go.';
      const prompt = buildConversationSummaryPrompt(history, note, lang, undefined, false, { userNoteSource: 'acp' });
      const headings = prompt.split('\n').filter((line) => /^## /u.test(line));
      expect(headings).toContain(lang === 'ja' ? '## ACP から来た発話' : '## Utterance from ACP');
      expect(headings).not.toContain(lang === 'ja' ? '## /go から来た発話' : '## Utterance from /go');
      const empty = buildConversationSummaryPrompt(history, '  ', lang, undefined, false, { userNoteSource: 'acp' });
      expect(empty.split('\n').filter((line) => /^## .*ACP/u.test(line))).toEqual([]);
    });
  });
  describe.each(['en', 'ja'] as const)('inline /go utterance in %s', (lang) => {
    it.each([false, true])('renders the utterance once separately from history when history=%s', (hasHistory) => {
      const note = lang === 'ja' ? 'それでお願いします' : 'That works for me.';
      const history = hasHistory ? [{ role: 'assistant' as const, content: 'Use iOS only.' }] : [];
      const prompt = buildConversationSummaryPrompt(history, note, lang);
      if (hasHistory) {
        expect(prompt).toContain('Assistant: Use iOS only.');
      }
      const headings = prompt.split('\n').filter((line) => /^#{1,6}\s.*\/go/u.test(line));
      expect(headings).toHaveLength(1);
      if (lang === 'ja') expect(headings[0]).toMatch(/[\p{Script=Han}\p{Script=Hiragana}]/u);
      expect(prompt.split(note)).toHaveLength(2);
      expect(history).toEqual(hasHistory ? [{ role: 'assistant', content: 'Use iOS only.' }] : []);
    });

    it.each(['', ' \t\n'])('omits the inline section for an empty utterance: %j', (note) => {
      const history = [{ role: 'user' as const, content: 'Add audit logs.' }];
      const prompt = buildConversationSummaryPrompt(history, note, lang);
      expect(prompt).toContain('User: Add audit logs.');
      expect(prompt.split('\n').filter((line) => /^#{1,6}\s.*\/go/u.test(line))).toEqual([]);
      expect(prompt).not.toMatch(/\{\{[^}]+\}\}/u);
      expect(buildConversationSummaryPrompt([], note, lang)).toBe('');
    });
  });
  it.each(['en', 'ja'] as const)('distinguishes provider defaults from no tools in %s previews', (lang) => {
    const preview = { name: 'worker', personaDisplayName: 'Worker', personaContent: '', instructionContent: '', canEdit: false };
    const defaults = formatStepPreviews([preview], lang);
    const empty = formatStepPreviews([{ ...preview, allowedTools: [] }], lang);
    expect(defaults).toContain(lang === 'ja' ? '未指定（provider標準）' : 'Unspecified (provider defaults)');
    expect(empty).not.toContain(lang === 'ja' ? '未指定（provider標準）' : 'Unspecified (provider defaults)');
    expect(empty).toContain(lang === 'ja' ? 'なし' : 'None');
  });
  it('includes taskHistory context when provided', () => {
    const history: TaskHistorySummaryItem[] = [
      {
        worktreeId: 'wt-1',
        status: 'completed',
        startedAt: '2026-02-10T00:00:00.000Z',
        completedAt: '2026-02-10T00:00:30.000Z',
        finalResult: 'completed',
        failureSummary: undefined,
        logKey: 'log-1',
      },
    ];
    const workflowContext: WorkflowContext = {
      name: 'my-workflow',
      description: 'desc',
      workflowStructure: '',
      stepPreviews: [],
      taskHistory: history,
    };

    const summary = buildSummaryPrompt(
      [{ role: 'user', content: 'Improve parser' }],
      false,
      'en',
      'No transcript',
      'Conversation:',
      workflowContext,
    );

    expect(summary).toContain('wt-1');
    expect(summary).toContain('Improve parser');
  });

  it('includes task-aware Gherkin output rules when formal specification mode is disabled', () => {
    const summary = buildSummaryPrompt(
      [{ role: 'user', content: 'Improve parser' }],
      false,
      'en',
      'No transcript',
      'Conversation:',
      undefined,
      undefined,
      undefined,
      false,
    );

    expect(summary).toContain('Gherkin');
    expect(summary).not.toContain('Quint');
    expect(summary).not.toContain('Alloy');
  });

  it('adds conditional Quint and Alloy guidance when formal specification mode is enabled', () => {
    const summary = buildSummaryPrompt(
      [{ role: 'user', content: 'Improve parser' }],
      false,
      'en',
      'No transcript',
      'Conversation:',
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(summary).toContain('Gherkin');
    expect(summary).toContain('Quint');
    expect(summary).toContain('Alloy');
    expect(summary).toContain('ASCII');
  });

});

describe('buildSummaryActionOptions', () => {
  const labels: SummaryActionLabels = {
    execute: 'Execute now',
    saveTask: 'Save as Task',
    continue: 'Continue editing',
  };

  it('should include all base actions when no exclude is given', () => {
    const options = buildSummaryActionOptions(labels);
    const values = options.map((o) => o.value);

    expect(values).toEqual(['execute', 'save_task', 'continue']);
  });

  it('should exclude specified actions', () => {
    const options = buildSummaryActionOptions(labels, [], ['execute']);
    const values = options.map((o) => o.value);

    expect(values).toEqual(['save_task', 'continue']);
    expect(values).not.toContain('execute');
  });

  it('should exclude multiple actions', () => {
    const options = buildSummaryActionOptions(labels, [], ['execute', 'continue']);
    const values = options.map((o) => o.value);

    expect(values).toEqual(['save_task']);
  });

  it('should handle append and exclude together', () => {
    const labelsWithIssue: SummaryActionLabels = {
      ...labels,
      createIssue: 'Create Issue',
    };
    const options = buildSummaryActionOptions(labelsWithIssue, ['create_issue'], ['execute']);
    const values = options.map((o) => o.value);

    expect(values).toEqual(['save_task', 'continue', 'create_issue']);
    expect(values).not.toContain('execute');
  });

  it('should return empty exclude by default (backward compatible)', () => {
    const options = buildSummaryActionOptions(labels, []);
    const values = options.map((o) => o.value);

    expect(values).toContain('execute');
    expect(values).toContain('save_task');
    expect(values).toContain('continue');
  });
});

describe('normal post-summary action selection', () => {
  function selector(lang: 'en' | 'ja' = 'en', exclude: readonly ('create_issue')[] = []) {
    const ui = getLabelObject<InteractiveSummaryUIText>('interactive.ui', lang);
    return createPostSummaryActionSelector('Proposed task', ui, exclude);
  }

  it('shows save, issue, immediate execution, and conversation in that order', async () => {
    await selector('ja')('Keep the agreed task');

    expect(promptMocks.select.mock.calls[0]?.[1]).toEqual([
      { label: 'タスクにつむ', value: 'save_task' },
      { label: 'Issueを建てる', value: 'create_issue' },
      { label: 'その場で実行する', value: 'execute' },
      { label: '会話を続ける', value: 'continue' },
    ]);
    expect(promptMocks.confirm).not.toHaveBeenCalled();
  });

  it('withholds the Issue choice while preserving the remaining order for PR sessions', async () => {
    await selector('en', ['create_issue'])('PR task');

    expect(promptMocks.select.mock.calls[0]?.[1].map((option: { value: string }) => option.value))
      .toEqual(['save_task', 'execute', 'continue']);
  });

  it('labels immediate execution at the current terminal in English', async () => {
    await selector('en')('Run task');
    const options = promptMocks.select.mock.calls[0]?.[1] as { value: string; label: string }[];
    const label = options.find((option) => option.value === 'execute')?.label;

    expect(label).toMatch(/execute|run/i);
    expect(label).toMatch(/here|in place|current terminal/i);
    expect(label).toMatch(/now|immediate/i);
  });

  it.each(['en', 'ja'] as const)('requires affirmative confirmation with default Yes for Issue and task in %s', async (lang) => {
    promptMocks.select.mockResolvedValueOnce('create_issue');
    const result = await selector(lang)('Issue task');

    expect(result).toBe('create_issue');
    expect(promptMocks.confirm).toHaveBeenCalledOnce();
    const [message, defaultYes] = promptMocks.confirm.mock.calls[0]!;
    expect(defaultYes).toBe(true);
    expect(message).not.toMatch(/\[[Yy]\/[Nn]\]/u);
    if (lang === 'ja') expect(message).toBe('タスクにつみますか？');
    else expect(message).toMatch(/task/i);
  });

  it('returns Issue-only instead of cancelling when the task confirmation is No', async () => {
    promptMocks.select.mockResolvedValueOnce('create_issue');
    promptMocks.confirm.mockResolvedValueOnce({ kind: 'value', value: false });

    await expect(selector()('Issue task')).resolves.toBe('create_issue_only');
  });

  it('keeps the same proposal in the menu when Issue confirmation is cancelled', async () => {
    promptMocks.select.mockResolvedValueOnce('create_issue').mockResolvedValueOnce('save_task');
    promptMocks.confirm.mockResolvedValueOnce({ kind: 'cancelled' });

    await expect(selector()('Issue task')).resolves.toBe('save_task');
    expect(promptMocks.select).toHaveBeenCalledTimes(2);
    expect(promptMocks.select.mock.calls[1]?.slice(0, 2)).toEqual(promptMocks.select.mock.calls[0]?.slice(0, 2));
  });

  it.each(['en', 'ja'] as const)('explains occupation and takt run with default No before execution in %s', async (lang) => {
    promptMocks.select.mockResolvedValueOnce('execute');

    await expect(selector(lang)('Run task')).resolves.toBe('execute');
    expect(promptMocks.confirm).toHaveBeenCalledOnce();
    const [message, defaultYes] = promptMocks.confirm.mock.calls[0]!;
    expect(defaultYes).toBe(false);
    expect(message).toContain('TUI');
    expect(message).toContain('takt run');
    expect(message).not.toMatch(/\[[Yy]\/[Nn]\]/u);
    if (lang === 'ja') {
      expect(message).toContain('ワークフローが終わるまで');
      expect(message).toContain('使えなく');
      expect(message).toContain('タスクにつんで');
    } else {
      expect(message).toMatch(/until.*workflow|workflow.*(?:finish|complet)/i);
      expect(message).toMatch(/(?:unavailable|unusable|cannot.*use|can't.*use)/i);
      expect(message).toMatch(/(?:save|queue).*task|task.*(?:save|queue)/i);
    }
  });

  it.each([{ kind: 'value', value: false }, { kind: 'cancelled' }] as const)(
    'returns to the menu instead of executing after $kind rejection', async (answer) => {
      promptMocks.select.mockResolvedValueOnce('execute').mockResolvedValueOnce('save_task');
      promptMocks.confirm.mockResolvedValueOnce(answer);

      await expect(selector()('Run task')).resolves.toBe('save_task');
      expect(promptMocks.select).toHaveBeenCalledTimes(2);
    },
  );

  it.each([null, 'continue'] as const)('lets menu cancellation or conversation choice %s return to input', async (action) => {
    promptMocks.select.mockResolvedValueOnce(action);

    await expect(selector()('Draft task')).resolves.toBe(action);
    expect(promptMocks.select).toHaveBeenCalledOnce();
    expect(promptMocks.confirm).not.toHaveBeenCalled();
  });

  it('keeps retry and instruct choices without introducing confirmation', async () => {
    const select = createSelectActionWithoutExecute({
      proposed: 'Revised task', actionPrompt: 'What next?',
      actions: { saveTask: 'Queue revised task', continue: 'Continue editing' },
    });

    await expect(select('Revised instruction', 'en')).resolves.toBe('save_task');
    expect(promptMocks.select.mock.calls[0]?.[1]).toEqual([
      { label: 'Queue revised task', value: 'save_task' },
      { label: 'Continue editing', value: 'continue' },
    ]);
    expect(promptMocks.confirm).not.toHaveBeenCalled();
  });
});
