import { Text, useInput } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { createElement, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvalScopeChoices, createPermissionProposal, type PendingQuestion } from '../features/manager/inquiryAnswer.js';
import { useManagerQuestionAnswer, type SaveManagerAnswer } from '../features/manager/useManagerQuestionAnswer.js';
import * as questionBodyLayout from '../features/manager/questionBodyLayout.js';
import type { ManagerAssignment } from '../features/manager/startupResolution.js';
import { applyEditorKey, createEditorState, type EditorState } from '../features/tui/editorState.js';
import { GoalInquiryInputSchema } from '../infra/goals/schema.js';

const repository = '/repository';
const question = { id: 'inquiry', kind: 'approval' as const, recipient: 'human' as const, status: 'pending' as const,
  body: 'Write output?', operation: { toolName: 'Write', args: '{"file_path":"out/result.txt","token":"secret-value"}',
    cwd: repository, argsDigest: '0'.repeat(64) } };
const target: PendingQuestion = { goalId: 'goal', repositoryDirectory: repository, objective: 'Output', question };
const workspace: ManagerAssignment = { kind: 'workspace', workspaceId: 'workspace', name: 'Workspace',
  repositoryDirectories: [repository, '/second'] };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mountAnswer(pending: PendingQuestion, onCancel?: () => void) {
  const save = vi.fn<SaveManagerAnswer>().mockResolvedValue(undefined);
  let currentAnswer!: ReturnType<typeof useManagerQuestionAnswer>;
  function Probe({ pending, bodyWidth }: { pending: PendingQuestion; bodyWidth: number }) {
    const answer = useManagerQuestionAnswer(bodyWidth);
    currentAnswer = answer;
    const [editorState, setEditorState] = useState(() => createEditorState(''));
    const editor = useRef(editorState);
    const edit = (next: EditorState): void => {
      editor.current = next;
      setEditorState(next);
    };
    useInput((input, key) => {
      if (input === 'o') answer.beginAnswer(pending, workspace, onCancel);
      else if (input === 'd') answer.beginAnswer(pending, workspace);
      else if (input === 'n') {
        answer.beginAnswer(pending, workspace);
        answer.handleNavigation({ ...key, downArrow: true }, editor);
      } else if (input === 'c') answer.clearAnswer();
      else if (answer.answerTarget !== null && !answer.handleNavigation(key, editor)) {
        if (answer.handleInput(key, key.return, editor, edit, save)) return;
        if (key.backspace) edit(applyEditorKey(editor.current, { kind: 'backspace' }));
        else if (input !== '' && !key.ctrl && !key.meta && !key.escape) {
          answer.switchToFreeText();
          edit(applyEditorKey(editor.current, { kind: 'insert', text: input }));
        }
      }
    });
    return createElement(Text, {}, answer.answerTarget === null ? 'Details closed'
      : `Details open ${answer.answerTarget.stage} ${answer.answerTarget.choice}${editorState.text === '' ? '' : ` input=${editorState.text}`}\n${answer.bodyText}`);
  }
  const app = render(createElement(Probe, { pending, bodyWidth: 80 }));
  return { app, save, body: () => app.lastFrame()!.split('\n').slice(1).join('\n'), answer: () => currentAnswer,
    rerender: (nextPending: PendingQuestion, bodyWidth: number) => app.rerender(createElement(Probe, { pending: nextPending, bodyWidth })) };
}

describe('manager inquiry detail input', () => {
  it('closes directly opened details on Esc without saving an answer', async () => {
    const { app, save } = mountAnswer(target);
    app.stdin.write('o');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Details open'));
    app.stdin.write('\x1b[27u');
    await vi.waitFor(() => expect(app.lastFrame()).toBe('Details closed'));
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'question' as const, stage: 'question', expected: { text: 'JSON' } },
    { kind: 'approval' as const, stage: 'decision', expected: { decision: 'deny', text: '' } },
    { kind: 'operation_request' as const, stage: 'report', expected: { report: 'unable', text: '' } },
  ])('gives $kind choice movement priority over long body scrolling', async ({ kind, stage, expected }) => {
    const pending: PendingQuestion = { ...target, question: {
      ...question, kind, body: Array.from({ length: 30 }, (_, index) => `Detail ${index}`).join('\n'), options: ['CSV', 'JSON'],
    } };
    const { app, save, body } = mountAnswer(pending);
    app.stdin.write('o');
    await vi.waitFor(() => expect(app.lastFrame()).toContain(`Details open ${stage} 0\n`));
    const initialBody = body();
    expect(initialBody).toContain('Detail 0');
    app.stdin.write('\x1b[B');
    await vi.waitFor(() => expect(app.lastFrame()).toContain(`Details open ${stage} 1\n`));
    expect(body()).toBe(initialBody);
    app.stdin.write('\r');
    if (kind !== 'question') app.stdin.write('\r');
    await vi.waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith(pending, expected));
  });

  it('keeps approval scope selection ahead of long body scrolling', async () => {
    const pending: PendingQuestion = { ...target, question: {
      ...question, body: Array.from({ length: 30 }, (_, index) => `Detail ${index}`).join('\n'),
    } };
    const { app, save, body } = mountAnswer(pending);
    app.stdin.write('o');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Details open'));
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Details open scope 0\n'));
    const initialBody = body();
    expect(initialBody).toContain('Detail 0');
    app.stdin.write('\x1b[B');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Details open scope 1\n'));
    expect(body()).toBe(initialBody);
    app.stdin.write('\r');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith(pending, { decision: 'allow', scope: 'goal', text: '' }));
  });

  it('scrolls the body within its bounds and starts at the beginning when reopened', async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `Body ${String(index).padStart(2, '0')}`);
    const pending: PendingQuestion = { ...target, question: { ...question, kind: 'question', body: lines.join('\n') } };
    const { app, save, body } = mountAnswer(pending);
    app.stdin.write('o');
    await vi.waitFor(() => expect(app.lastFrame()).toContain(lines[0]!));
    const initial = app.lastFrame()!;
    const count = lines.filter((line) => initial.includes(line)).length;
    expect(count).toBe(8);
    expect(body()).toBe(lines.slice(0, 8).join('\n'));
    app.stdin.write('\x1b[A');
    app.stdin.write('\x1b[B');
    await vi.waitFor(() => {
      expect(app.lastFrame()).not.toContain(lines[0]!);
      expect(app.lastFrame()).toContain(lines[count]!);
    });
    for (let move = 0; move < 100; move++) app.stdin.write('\x1b[B');
    await vi.waitFor(() => expect(body()).toBe(lines.slice(-8).join('\n')));
    app.stdin.write('\x1b[A');
    await vi.waitFor(() => expect(app.lastFrame()).not.toContain(lines.at(-1)!));
    for (let move = 0; move < 100; move++) app.stdin.write('\x1b[A');
    await vi.waitFor(() => expect(app.lastFrame()).toBe(initial));
    app.stdin.write('\x1b[B');
    await vi.waitFor(() => expect(body()).toBe(lines.slice(1, 9).join('\n')));
    app.stdin.write('\x1b[27u');
    await vi.waitFor(() => expect(app.lastFrame()).toBe('Details closed'));
    app.stdin.write('o');
    await vi.waitFor(() => expect(app.lastFrame()).toBe(initial));
    expect(save).not.toHaveBeenCalled();
  });

  it('discards a return destination when details are cleared or started directly', async () => {
    const onCancel = vi.fn();
    const { app, save } = mountAnswer(target, onCancel);
    app.stdin.write('o');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Details open'));
    app.stdin.write('c');
    await vi.waitFor(() => expect(app.lastFrame()).toBe('Details closed'));
    expect(onCancel).not.toHaveBeenCalled();
    app.stdin.write('o');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Details open'));
    app.stdin.write('d');
    app.stdin.write('\x1b[27u');
    await vi.waitFor(() => expect(app.lastFrame()).toBe('Details closed'));
    expect(onCancel).not.toHaveBeenCalled();
    app.stdin.write('o');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Details open'));
    app.stdin.write('\x1b[27u');
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
    expect(save).not.toHaveBeenCalled();
  });
});

describe('manager question body memoization', () => {
  it('reuses one layout across five answer edits and body navigation for a 200-row question', async () => {
    const layout = vi.spyOn(questionBodyLayout, 'layoutQuestionBody');
    const lines = Array.from({ length: 200 }, (_, index) => `Body ${index}`);
    const pending: PendingQuestion = { ...target, question: { ...question, kind: 'question', body: lines.join('\n') } };
    const { app, body } = mountAnswer(pending);
    app.stdin.write('o');
    await vi.waitFor(() => expect(body()).toBe(lines.slice(0, 8).join('\n')));
    expect(layout).toHaveBeenCalledExactlyOnceWith(pending.question.body, 80);
    for (let index = 1; index <= 5; index++) {
      app.stdin.write(String(index));
      await vi.waitFor(() => expect(app.lastFrame()).toContain(`input=${'12345'.slice(0, index)}\n`));
      expect(body()).toBe(lines.slice(0, 8).join('\n'));
      expect(layout).toHaveBeenCalledTimes(1);
    }
    app.stdin.write('\x1b[B');
    for (let index = 0; index < 5; index++) app.stdin.write('\x7f');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Details open question null\n'));
    expect(body()).toBe(lines.slice(0, 8).join('\n'));
    app.stdin.write('\x1b[B');
    await vi.waitFor(() => expect(body()).toBe(lines.slice(1, 9).join('\n')));
    expect(layout).toHaveBeenCalledTimes(1);
  });

  it('updates the rendered rows and scroll bounds when the same hook changes width', async () => {
    const layout = vi.spyOn(questionBodyLayout, 'layoutQuestionBody');
    const lines = Array.from({ length: 10 }, (_, index) => `Row ${String(index).padStart(2, '0')}abcdefghij`);
    const wrapped = lines.flatMap((line) => [line.slice(0, 8), line.slice(8)]);
    const pending: PendingQuestion = { ...target, question: { ...question, kind: 'question', body: lines.join('\n') } };
    const { app, body, answer, rerender } = mountAnswer(pending);
    app.stdin.write('o');
    await vi.waitFor(() => expect(body()).toBe(lines.slice(0, 8).join('\n')));
    for (let index = 0; index < 20; index++) app.stdin.write('\x1b[B');
    await vi.waitFor(() => expect(body()).toBe(lines.slice(-8).join('\n')));
    expect(answer().answerTarget?.bodyOffset).toBe(2);
    expect(layout).toHaveBeenCalledExactlyOnceWith(pending.question.body, 80);

    rerender(pending, 8);
    await vi.waitFor(() => expect(body()).toBe(wrapped.slice(2, 10).join('\n')));
    expect(layout).toHaveBeenNthCalledWith(2, pending.question.body, 8);
    for (let index = 0; index < 20; index++) app.stdin.write('\x1b[B');
    await vi.waitFor(() => expect(body()).toBe(wrapped.slice(-8).join('\n')));
    expect(answer().answerTarget?.bodyOffset).toBe(12);
    expect(layout).toHaveBeenCalledTimes(2);

    rerender(pending, 80);
    await vi.waitFor(() => expect(body()).toBe(lines.slice(-8).join('\n')));
    app.stdin.write('\x1b[A');
    await vi.waitFor(() => expect(body()).toBe(lines.slice(1, 9).join('\n')));
    expect(answer().answerTarget?.bodyOffset).toBe(1);
    expect(layout).toHaveBeenNthCalledWith(3, pending.question.body, 80);
    expect(layout).toHaveBeenCalledTimes(3);
  });

  it('updates the rendered rows and scroll bounds when the body changes with the same inquiry ID', async () => {
    const layout = vi.spyOn(questionBodyLayout, 'layoutQuestionBody');
    const lines = Array.from({ length: 30 }, (_, index) => `Old ${index}`);
    const nextLines = Array.from({ length: 12 }, (_, index) => `New ${index}`);
    const pending: PendingQuestion = { ...target, question: { ...question, kind: 'question', body: lines.join('\n') } };
    const nextPending = { ...pending, question: { ...pending.question, body: nextLines.join('\n') } };
    const { app, body, answer } = mountAnswer(pending);
    app.stdin.write('o');
    await vi.waitFor(() => expect(body()).toBe(lines.slice(0, 8).join('\n')));
    for (let index = 0; index < 40; index++) app.stdin.write('\x1b[B');
    await vi.waitFor(() => expect(body()).toBe(lines.slice(-8).join('\n')));
    expect(layout).toHaveBeenCalledExactlyOnceWith(pending.question.body, 80);

    answer().beginAnswer(nextPending, workspace);
    await vi.waitFor(() => expect(body()).toBe(nextLines.slice(0, 8).join('\n')));
    for (let index = 0; index < 40; index++) app.stdin.write('\x1b[B');
    await vi.waitFor(() => expect(body()).toBe(nextLines.slice(-8).join('\n')));
    expect(answer().answerTarget?.bodyOffset).toBe(4);
    expect(layout).toHaveBeenNthCalledWith(2, nextPending.question.body, 80);
    expect(layout).toHaveBeenCalledTimes(2);
  });

  it('uses the new inquiry body for navigation immediately after beginAnswer before rendering', async () => {
    const layout = vi.spyOn(questionBodyLayout, 'layoutQuestionBody');
    const pending: PendingQuestion = { ...target, question: { ...question, kind: 'question', body: 'Short body' } };
    const lines = Array.from({ length: 12 }, (_, index) => `New ${index}`);
    const nextPending = { ...pending, question: { ...pending.question, id: 'next-inquiry', body: lines.join('\n') } };
    const { app, body, answer, rerender } = mountAnswer(pending);
    app.stdin.write('o');
    await vi.waitFor(() => expect(body()).toBe('Short body'));
    expect(layout).toHaveBeenCalledExactlyOnceWith('Short body', 80);
    const beforeRerender = answer();
    rerender(nextPending, 80);
    await vi.waitFor(() => expect(answer()).not.toBe(beforeRerender));
    expect(answer().answerTarget?.pending).toBe(pending);
    app.stdin.write('n');
    await vi.waitFor(() => expect(body()).toBe(lines.slice(1, 9).join('\n')));
    expect(answer().answerTarget?.pending).toBe(nextPending);
    expect(answer().answerTarget?.bodyOffset).toBe(1);
    for (let index = 0; index < 20; index++) app.stdin.write('\x1b[B');
    await vi.waitFor(() => expect(body()).toBe(lines.slice(-8).join('\n')));
    expect(answer().answerTarget?.bodyOffset).toBe(4);
    expect(layout).toHaveBeenNthCalledWith(2, nextPending.question.body, 80);
    expect(layout).toHaveBeenCalledTimes(2);
  });

  it('keeps layouts independent between hook instances with identical bodies and widths', async () => {
    const layout = vi.spyOn(questionBodyLayout, 'layoutQuestionBody');
    const first = mountAnswer(target);
    first.app.stdin.write('o');
    await vi.waitFor(() => expect(first.body()).toBe(question.body));
    expect(layout).toHaveBeenCalledExactlyOnceWith(question.body, 80);
    const second = mountAnswer(target);
    second.app.stdin.write('o');
    await vi.waitFor(() => expect(second.body()).toBe(question.body));
    expect(layout).toHaveBeenNthCalledWith(2, question.body, 80);
    expect(layout).toHaveBeenCalledTimes(2);
  });

  it('keeps the body empty before opening and after closing details despite a cached layout', async () => {
    const layout = vi.spyOn(questionBodyLayout, 'layoutQuestionBody');
    const { app, answer, body } = mountAnswer(target);
    expect(answer().bodyText).toBe('');
    expect(layout).not.toHaveBeenCalled();
    app.stdin.write('o');
    await vi.waitFor(() => expect(body()).toBe(question.body));
    app.stdin.write('\x1b[27u');
    await vi.waitFor(() => expect(app.lastFrame()).toBe('Details closed'));
    expect(answer().bodyText).toBe('');
    expect(layout).toHaveBeenCalledExactlyOnceWith(question.body, 80);
  });
});

describe('manager question body layout', () => {
  it.each([
    { body: '', width: 4, expected: [''] },
    { body: 'abcdefgh', width: 4, expected: ['abcd', 'efgh'] },
    { body: 'あe\u0301👩‍💻い', width: 4, expected: ['あe\u0301', '👩‍💻い'] },
    { body: 'a\r\n\r\nb\tc', width: 8, expected: ['a', '', 'b c'] },
    { body: '前\x1b[31m赤\x1b[0m', width: 4, expected: ['前赤'] },
  ])('wraps $body into display rows of width $width without splitting graphemes', ({ body, width, expected }) => {
    expect(questionBodyLayout.layoutQuestionBody(body, width)).toEqual(expected);
  });
});

describe('manager inquiry answer preparation', () => {
  it('offers every goal approval scope with once first and concrete permission destinations', () => {
    const choices = approvalScopeChoices(target, workspace);
    expect(choices.map(({ value }) => value)).toEqual(['once', 'goal', 'project', 'workspace', 'global']);
    expect(choices.map(({ permission }) => permission)).toEqual([undefined, undefined,
      { kind: 'project', projectDirectory: repository }, { kind: 'workspace', workspaceId: 'workspace' }, { kind: 'global' }]);
  });

  it.each(['repository', 'workspace'] as const)('combines project and manager for one %s repository without widening its destination', (kind) => {
    const assignment: ManagerAssignment = kind === 'workspace' ? { ...workspace, repositoryDirectories: [repository] }
      : { kind, repositoryDirectory: repository, repositoryDirectories: [repository] };
    const choices = approvalScopeChoices(target, assignment);
    expect(choices.map(({ value }) => value)).toEqual(['once', 'goal', 'project', 'global']);
    expect(choices[2]).toEqual({ value: 'project', label: 'projectManager', permission: { kind: 'project', projectDirectory: repository } });
  });

  it('omits goal scope for a standalone inquiry and retains its operation directory for project resolution', () => {
    const choices = approvalScopeChoices({ goalId: null, owner: { kind: 'workspace', workspaceId: 'workspace' }, question }, workspace);
    expect(choices.map(({ value }) => value)).toEqual(['once', 'project', 'workspace', 'global']);
    expect(choices[1]!.permission).toEqual({ kind: 'project', projectDirectory: repository });
  });

  it('builds one editable sentence containing tool, target and cwd without sensitive values', () => {
    const proposal = createPermissionProposal({ ...question.operation, args: question.operation.args + '\n' });
    for (const value of ['Write', 'out/result.txt', repository]) expect(proposal).toContain(value);
    expect(proposal).not.toContain('secret-value');
    expect(proposal).not.toMatch(/[\r\n]/u);
  });

  it.each([131072, 131073])('bounds a proposal whose full sentence would contain %i characters without losing its tool, target or directory', (length) => {
    const args = JSON.stringify({ file_path: 'out/result.txt', content: '' });
    const prefix = `Allow Write with ${args} in ${repository}.`;
    const operation = { toolName: 'Write', cwd: repository,
      args: JSON.stringify({ file_path: 'out/result.txt', content: 'x'.repeat(length - prefix.length) }) };
    expect(`Allow ${operation.toolName} with ${operation.args} in ${operation.cwd}.`).toHaveLength(length);
    const proposal = createPermissionProposal(operation);
    expect(GoalInquiryInputSchema.safeParse({ kind: 'approval', body: 'Write output?', operation, permissionProposal: proposal }).success).toBe(true);
    for (const value of ['Write', 'out/result.txt', repository, '…']) expect(proposal).toContain(value);
    expect(proposal).not.toMatch(/[\r\n]/u);
    expect(JSON.parse(operation.args).content).toHaveLength(length - prefix.length);
  });

});
