import { describe, expect, it, vi } from 'vitest';

const render = vi.hoisted(() => vi.fn());
vi.mock('../shared/prompts/index.js', () => ({ loadTemplate: render }));

import { formatInlineUtteranceSection, type InlineUtteranceSource } from '../features/interactive/promptSections.js';

describe('formatInlineUtteranceSection', () => {
  it.each(['go', 'acp', 'retry', 'task_list_revision', 'tell', 'requeue'] satisfies InlineUtteranceSource[])(
    'passes the normalized utterance and only the invoked %s source to the template',
    (source) => {
      render.mockReset().mockReturnValue(' rendered section ');
      expect(formatInlineUtteranceSection('ja', source, '  Add logs.  ')).toBe('rendered section');
      expect(render).toHaveBeenCalledWith('parts/inline_utterance', 'ja', {
        go: source === 'go', acp: source === 'acp', retry: source === 'retry',
        taskListRevision: source === 'task_list_revision', tell: source === 'tell',
        requeue: source === 'requeue', utterance: '```text\nAdd logs.\n```',
      });
    },
  );

  it.each(['', ' \t\n'])('omits the section and does not load a template for %j', (note) => {
    render.mockClear();
    expect(formatInlineUtteranceSection('en', 'go', note)).toBe('');
    expect(render).not.toHaveBeenCalled();
  });
});
