/**
 * Tests for task history context formatting in interactive summary.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatStepPreviews } from '../features/interactive/interactive-summary.js';
import { buildConversationSummaryPrompt } from '../features/interactive/interactiveApplication.js';

const templateCalls = vi.hoisted(() => vi.fn());
vi.mock('../shared/prompts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/prompts/index.js')>();
  return {
    ...actual,
    loadTemplate: (...args: Parameters<typeof actual.loadTemplate>) => {
      templateCalls(...args);
      return actual.loadTemplate(...args);
    },
  };
});

beforeEach(() => templateCalls.mockClear());

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
    it.each([false, true])('passes the utterance as a template variable separately from history when history=%s', (hasHistory) => {
      const note = lang === 'ja' ? 'それでお願いします' : 'That works for me.';
      const history = hasHistory ? [{ role: 'assistant' as const, content: 'Use iOS only.' }] : [];
      const prompt = buildConversationSummaryPrompt(history, note, lang);
      const vars = templateCalls.mock.calls.find(([name]) => name === 'score_summary_system_prompt')?.[2] as Record<string, unknown>;
      expect(vars).toBeDefined();
      expect(vars.conversation).toBe(hasHistory ? `${lang === 'ja' ? '会話' : 'Conversation'}\nAssistant: Use iOS only.` : '');
      const utteranceVariables = Object.entries(vars).filter(([key, value]) => key !== 'conversation' && typeof value === 'string' && value.includes(note));
      expect(utteranceVariables.length).toBeGreaterThan(0);
      if (hasHistory) {
        buildConversationSummaryPrompt([], note, lang);
        const withoutHistory = templateCalls.mock.calls.filter(([name]) => name === 'score_summary_system_prompt').at(-1)?.[2] as Record<string, unknown>;
        expect(Object.entries(withoutHistory).filter(([key, value]) => key !== 'conversation' && typeof value === 'string' && value.includes(note))).toEqual(utteranceVariables);
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
