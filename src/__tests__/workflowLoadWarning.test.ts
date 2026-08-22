import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { formatWorkflowLoadWarning } from '../infra/config/loaders/workflowLoadWarning.js';

describe('formatWorkflowLoadWarning', () => {
  it('ANSI escape と制御文字を可視化して警告文へ埋め込む', () => {
    const error = new Error('bad\x1b]0;title\x07value\nnext');

    const warning = formatWorkflowLoadWarning('bad\n\x1b[31mname', error);

    expect(warning).toContain('bad\\nname');
    expect(warning).toContain('badvalue\\nnext');
    expect(warning).not.toContain('\x1b');
  });

  it('ZodError の issue path と message もサニタイズする', () => {
    const error = new ZodError([
      {
        code: 'custom',
        path: ['steps', 0, 'name\nbad'],
        message: 'invalid\tvalue',
      },
    ]);

    const warning = formatWorkflowLoadWarning('workflow', error);

    expect(warning).toContain('workflow');
    expect(warning).toContain('steps.0.name\\nbad');
    expect(warning).toContain('invalid\\tvalue');
  });

  it('issue path は入力値をそのまま表示する', () => {
    const error = new ZodError([
      {
        code: 'custom',
        path: ['unknown_field'],
        message: 'required',
      },
    ]);

    const warning = formatWorkflowLoadWarning('workflow', error);

    expect(warning).toContain('unknown_field');
  });
});
