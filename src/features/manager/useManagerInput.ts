import { useInput, usePaste } from 'ink';
import type { RefObject } from 'react';
import { applyEditorKey, commitEditorInput, replaceEditorText, type EditorState } from '../tui/editorState.js';
import type { useSlashCompletion } from '../tui/useSlashCompletion.js';
import { resolveEditorKey } from '../tui/editorKeys.js';
import type { ManagerAbortTarget, useManagerAbortConfirmation } from './useManagerAbortConfirmation.js';
import type { SaveManagerAnswer, useManagerQuestionAnswer } from './useManagerQuestionAnswer.js';
import type { useManagerSummaryApproval } from './useManagerSummaryApproval.js';
import type { ManagerSelectedTarget, ManagerSelectionCommand, useManagerSelection } from './useManagerSelection.js';

export const MAKE_GOAL_COMMAND = '/make-goal';

export function useManagerInput({
  exiting, active, registering, editorRef, edit, submit, onExit, contentWidth, canApprove, abortTurn,
  abortConfirmation, questionAnswer, summaryApproval, selection, selectTarget, abortGoal, saveAnswer, register, onInputUnavailable,
  openMenu, slashCompletion,
}: {
  exiting: RefObject<boolean>;
  active: RefObject<boolean>;
  registering: RefObject<boolean>;
  editorRef: RefObject<EditorState>;
  edit: (next: EditorState) => void;
  submit: (text: string) => void;
  abortTurn: () => void;
  onExit: () => void;
  contentWidth: number;
  canApprove: boolean;
  abortConfirmation: ReturnType<typeof useManagerAbortConfirmation>;
  questionAnswer: ReturnType<typeof useManagerQuestionAnswer>;
  summaryApproval: ReturnType<typeof useManagerSummaryApproval>;
  selection: ReturnType<typeof useManagerSelection>;
  selectTarget: (target: ManagerSelectedTarget) => void;
  abortGoal: (target: ManagerAbortTarget) => Promise<void>;
  saveAnswer: SaveManagerAnswer;
  register: (revision: number) => Promise<void>;
  onInputUnavailable: () => void;
  openMenu: (kind: ManagerSelectionCommand) => void;
  slashCompletion: ReturnType<typeof useSlashCompletion>;
}): void {
  const { abortTarget } = abortConfirmation;
  const { answerTarget } = questionAnswer;
  const { pending, setPending } = summaryApproval;
  const editDraft = (next: EditorState): void => {
    if (!registering.current && pending !== null
      && answerTarget === null && selection.selection === null && abortTarget === null
      && next.text !== editorRef.current.text
      && !(next.text.trim() !== '' && MAKE_GOAL_COMMAND.startsWith(next.text.trim()))) {
      summaryApproval.dismiss(pending);
    }
    edit(next);
    slashCompletion.reset();
  };
  const insertText = (text: string): void => {
    if (exiting.current || (answerTarget !== null && active.current)) return;
    if (selection.selection !== null) return;
    if (abortTarget !== null) { onInputUnavailable(); return; }
    if (answerTarget !== null) questionAnswer.switchToFreeText();
    editDraft(applyEditorKey(editorRef.current, { kind: 'insert', text }));
  };
  usePaste(insertText);
  useInput((input, key) => {
    if (exiting.current) return;
    if (key.ctrl && input === 'c') {
      exiting.current = true;
      onExit();
      return;
    }
    if (key.ctrl && (input === 'r' || input === 'g')) {
      openMenu(input === 'r' ? 'answer' : 'goal');
      return;
    }
    if (selection.selection !== null) {
      selection.handleInput(key, selectTarget);
      return;
    }
    if (questionAnswer.handleNavigation(key, editorRef)) {
      return;
    }
    if (active.current && key.escape) {
      abortTurn();
      setPending(null);
      return;
    }
    if (registering.current && key.escape) {
      return;
    }
    if (answerTarget !== null && active.current) return;
    if (!registering.current && !active.current && abortTarget !== null) {
      if (input !== '' && !key.ctrl && !key.meta && !key.return && !key.escape) onInputUnavailable();
      abortConfirmation.handleInput(abortTarget, key, abortGoal);
      return;
    }
    const editKey = resolveEditorKey(input, key, contentWidth);
    if (key.ctrl && editKey === null) return;
    if (answerTarget === null && slashCompletion.handleInput(key, (text) => {
      editDraft(replaceEditorText(editorRef.current, text));
    })) return;
    // Ink は本文と同じチャンクに入った CR/LF を Enter と分類しない。
    const trailingEnter = !key.return && !(key.shift || key.meta)
      && editKey?.kind === 'insert' && /[\r\n]$/u.test(input);
    if (trailingEnter) insertText(input.replace(/(?:\r\n|\r|\n)$/u, ''));
    const submitInput = key.return || trailingEnter;
    if (!registering.current && !active.current && answerTarget !== null) {
      if (questionAnswer.handleInput(key, submitInput, editorRef, edit, saveAnswer)) return;
    }
    if (!registering.current && canApprove && answerTarget === null && pending !== null
      && (key.escape || (editorRef.current.text === ''
        && (key.upArrow || key.downArrow || (editKey === null && !key.return)
          || (key.return && !key.shift && !key.meta))))) {
      if (summaryApproval.handleInput(pending, key, register)) return;
    }
    if (submitInput) {
      if (key.shift || key.meta) {
        editDraft(applyEditorKey(editorRef.current, { kind: 'newline' }));
      } else if (editorRef.current.text.trim() !== '') {
        const text = editorRef.current.text;
        edit(commitEditorInput(editorRef.current, text));
        slashCompletion.reset();
        submit(text);
      }
      return;
    }
    if (editKey !== null) {
      if (editKey.kind === 'insert') insertText(editKey.text);
      else editDraft(applyEditorKey(editorRef.current, editKey));
    }
  });
}
