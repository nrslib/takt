import { expect, it, vi } from 'vitest';
import type { Key } from 'ink';
import { useManagerInput } from '../features/manager/useManagerInput.js';
import { createEditorState } from '../features/tui/editorState.js';
import { createInquiry } from '../infra/goals/inquiry.js';

const hooks = vi.hoisted(() => ({ input: vi.fn(), paste: vi.fn() }));
vi.mock('ink', () => ({ useInput: hooks.input, usePaste: hooks.paste }));
const key: Key = { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false };
function fixture() {
  hooks.input.mockClear(); hooks.paste.mockClear();
  const options: Parameters<typeof useManagerInput>[0] = {
    exiting: { current: false }, active: { current: true }, registering: { current: false }, savingAnswer: { current: null }, editorRef: { current: createEditorState('answer') },
    edit: vi.fn(), submit: vi.fn(), abortTurn: vi.fn(), onExit: vi.fn(), browseTools: vi.fn(), contentWidth: 80, canApprove: true,
    abortConfirmation: { abortTarget: null, setAbortTarget: vi.fn(), handleInput: vi.fn() },
    questionAnswer: { answerTarget: null, bodyText: '', clearAnswer: vi.fn(() => true), beginAnswer: vi.fn(), switchToFreeText: vi.fn(),
      handleNavigation: vi.fn(() => false), handleInput: vi.fn(() => true) },
    summaryApproval: { pending: null, setPending: vi.fn(), dismiss: vi.fn(), handleInput: vi.fn(() => true) },
    selection: { selection: null, open: vi.fn(() => true), close: vi.fn(), refresh: vi.fn(), handleInput: vi.fn() },
    selectTarget: vi.fn(), abortGoal: vi.fn(async () => {}), saveAnswer: vi.fn(async () => {}), register: vi.fn(async () => {}),
    onInputUnavailable: vi.fn(), openMenu: vi.fn(), slashCompletion: { completions: [], completionIndex: 0, reset: vi.fn(), handleInput: vi.fn(() => false) },
    epicsOpen: false, openEpics: vi.fn(), handleEpicInput: vi.fn(),
  };
  return { options, bind() {
    useManagerInput(options);
    return hooks.input.mock.calls.at(-1)![0] as (input: string, key: Key) => void;
  } };
}
it('routes history controls without changing the draft, completion selection or active turn', () => {
  const f = fixture(); const input = f.bind();
  f.options.editorRef.current = { ...createEditorState('日本語の下書き'), cursor: 3 };
  const editor = structuredClone(f.options.editorRef.current);
  input('t', { ...key, ctrl: true });
  input('', { ...key, pageDown: true });
  input('', { ...key, pageUp: true });
  expect(vi.mocked(f.options.browseTools).mock.calls).toEqual([['toggle'], ['next'], ['previous']]);
  expect(f.options.editorRef.current).toEqual(editor);
  expect(f.options.edit).not.toHaveBeenCalled();
  expect(f.options.submit).not.toHaveBeenCalled();
  expect(f.options.abortTurn).not.toHaveBeenCalled();
  expect(f.options.slashCompletion.reset).not.toHaveBeenCalled();
  input('', { ...key, escape: true });
  expect(f.options.abortTurn).toHaveBeenCalledOnce();
});
it('accepts and edits an inquiry answer while a model turn is active', () => {
  const f = fixture();
  f.options.questionAnswer.answerTarget = { pending: { goalId: null, owner: { kind: 'repository', repositoryDirectory: '/repo' },
    question: createInquiry({ body: 'Width?' }) }, stage: 'question', choice: null, answer: {}, bodyOffset: 0 };
  const input = f.bind();
  input('', { ...key, return: true });
  expect(f.options.questionAnswer.handleInput).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ return: true }), true,
    f.options.editorRef, f.options.saveAnswer);
  const paste = hooks.paste.mock.calls.at(-1)![0] as (text: string) => void;
  paste('80');
  expect(f.options.questionAnswer.switchToFreeText).toHaveBeenCalledOnce();
  expect(f.options.edit).toHaveBeenCalled();
});
it('confirms a goal abort during a model turn and routes Escape only to turn interruption', () => {
  const f = fixture();
  f.options.abortConfirmation.abortTarget = { goal: { id: 'goal', objective: 'Goal', status: 'created', executionStatus: 'active' }, retry: false };
  const input = f.bind();
  input('', { ...key, return: true });
  expect(f.options.abortConfirmation.handleInput).toHaveBeenCalledExactlyOnceWith(f.options.abortConfirmation.abortTarget,
    expect.objectContaining({ return: true }), f.options.abortGoal);
  input('', { ...key, escape: true });
  expect(f.options.abortTurn).toHaveBeenCalledOnce();
});
it('submits a new human message and opens read menus during a model turn', () => {
  const f = fixture(); const input = f.bind();
  input('', { ...key, return: true });
  expect(f.options.submit).toHaveBeenCalledExactlyOnceWith('answer');
  input('r', { ...key, ctrl: true }); input('g', { ...key, ctrl: true });
  expect(vi.mocked(f.options.openMenu).mock.calls).toEqual([['answer'], ['goal']]);
});


it('submits /verify from the TUI without dismissing the pending proposal while typing', () => {
  const f = fixture();
  f.options.editorRef.current = createEditorState('/verif');
  f.options.summaryApproval.pending = { revision: 1, repositoryDirectory: '/repo', summary: {
    objective: 'Export', outOfScope: [], acceptanceCriteria: ['Check specifications'], constraints: [],
    specifications: { gherkin: 'Feature: Export' },
  } };
  const input = f.bind();
  input('y', key);
  expect(f.options.summaryApproval.dismiss).not.toHaveBeenCalled();
  f.options.editorRef.current = createEditorState('/verify');
  input('', { ...key, return: true });
  expect(f.options.submit).toHaveBeenCalledExactlyOnceWith('/verify');
});

it('routes Epic navigation before turn interruption and blocks pasted conversation input while browsing', () => {
  const f = fixture();
  f.options.epicsOpen = true;
  const input = f.bind();
  input('', { ...key, escape: true });
  expect(f.options.handleEpicInput).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ escape: true }));
  expect(f.options.abortTurn).not.toHaveBeenCalled();
  const paste = hooks.paste.mock.calls.at(-1)![0] as (text: string) => void;
  paste('Do not modify the draft');
  expect(f.options.edit).not.toHaveBeenCalled();
  input('o', { ...key, ctrl: true });
  expect(f.options.openEpics).toHaveBeenCalledOnce();
  expect(f.options.submit).not.toHaveBeenCalled();
});
