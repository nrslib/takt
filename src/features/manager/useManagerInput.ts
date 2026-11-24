import { useInput, usePaste, type Key } from 'ink';
import type { useManagerImages } from './useManagerImages.js';
import type { RefObject } from 'react';
import { applyEditorKey, commitEditorInput, replaceEditorText, type EditorState } from '../tui/editorState.js';
import type { useSlashCompletion } from '../tui/useSlashCompletion.js';
import { resolveEditorKey } from '../tui/editorKeys.js';
import type { ManagerGoalConfirmationTarget, useManagerAbortConfirmation } from './useManagerAbortConfirmation.js';
import type { SaveManagerAnswer, useManagerQuestionAnswer } from './useManagerQuestionAnswer.js';
import type { useManagerSummaryApproval } from './useManagerSummaryApproval.js';
import type { ManagerSelectedTarget, ManagerSelectionCommand, useManagerSelection } from './useManagerSelection.js';
import { CLEAR_COMMAND } from './conversationCommands.js';

export const MAKE_GOAL_COMMAND = '/make-goal';

export function useManagerInput({
  exiting, active, registering, savingAnswer, editorRef, edit, submit, onExit, contentWidth, canApprove, abortTurn,
  abortConfirmation, questionAnswer, summaryApproval, selection, selectTarget, confirmGoalOperation, saveAnswer, register, onInputUnavailable,
  openMenu, slashCompletion, isEpicsOpen, openEpics, handleEpicInput, browseTools, images, currentHandlers,
}: {
  images: ReturnType<typeof useManagerImages>;
  currentHandlers: RefObject<{ pasteText(text: string): void; handleInput(input: string, key: Key): void } | null>;
  exiting: RefObject<boolean>;
  active: RefObject<boolean>;
  registering: RefObject<boolean>;
  savingAnswer: RefObject<{ operationId: string | null } | null>;
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
  confirmGoalOperation: (target: ManagerGoalConfirmationTarget) => Promise<void>;
  saveAnswer: SaveManagerAnswer;
  register: (revision: number) => Promise<void>;
  onInputUnavailable: (confirming: ManagerGoalConfirmationTarget['kind']) => void;
  openMenu: (kind: ManagerSelectionCommand) => void;
  isEpicsOpen: () => boolean;
  openEpics: () => void;
  handleEpicInput: (key: Key) => void;
  slashCompletion: ReturnType<typeof useSlashCompletion>;
  browseTools: (direction: 'toggle' | 'previous' | 'next') => void;
}): void {
  const { abortTarget } = abortConfirmation;
  const { answerTarget } = questionAnswer;
  const { pending, setPending } = summaryApproval;
  const editDraft = (next: EditorState): void => {
    if (!registering.current && pending !== null
      && answerTarget === null && !selection.isOpen() && abortTarget === null
      && next.text !== editorRef.current.text
      && !(next.text.trim() !== '' && [MAKE_GOAL_COMMAND, '/verify', CLEAR_COMMAND].some((command) => command.startsWith(next.text.trim())))) {
      summaryApproval.dismiss(pending);
    }
    edit(next);
    slashCompletion.reset();
  };
  const insertText = (text: string, kind: 'insert' | 'paste' = 'insert'): void => {
    if (exiting.current || savingAnswer.current) return;
    if (selection.isOpen() || isEpicsOpen()) return;
    if (abortTarget !== null) { onInputUnavailable(abortTarget.kind); return; }
    if (answerTarget !== null) questionAnswer.switchToFreeText();
    editDraft(applyEditorKey(editorRef.current, { kind, text }));
  };
  const pasteText = (text: string): void => {
    if (images.hasPending()) { images.defer(() => currentHandlers.current?.pasteText(text)); return; }
    images.paste.flushPending();
    insertText(text, 'paste');
  };
  usePaste(pasteText);
  const handleInput = (input: string, key: Key): void => {
    if (exiting.current) return;
    if (key.ctrl && input === 'c') {
      exiting.current = true;
      onExit();
      return;
    }
    if (images.hasPending()) { images.defer(() => currentHandlers.current?.handleInput(input, key)); return; }
    if (savingAnswer.current) return;
    if (answerTarget === null && !selection.isOpen() && abortTarget === null && !isEpicsOpen()) {
      if (images.paste.routeInput(input, key)) return;
      if (key.ctrl && input === 'v') { images.paste.captureClipboard(); return; }
    }
    if (key.ctrl && input === 't') {
      openEpics();
      return;
    }
    if (key.ctrl && (input === 'r' || input === 'g')) {
      openMenu(input === 'r' ? 'answer' : 'goal');
      return;
    }
    if (isEpicsOpen()) {
      handleEpicInput(key);
      return;
    }
    if (selection.isOpen()) {
      selection.handleInput(key, selectTarget);
      return;
    }
    if (questionAnswer.handleNavigation(key, editorRef)) {
      return;
    }
    if (abortTarget === null && (key.ctrl && input === 'o' || key.pageUp || key.pageDown)) {
      browseTools(key.ctrl ? 'toggle' : key.pageUp ? 'previous' : 'next');
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
    if (abortTarget !== null) {
      if (input !== '' && !key.ctrl && !key.meta && !key.return && !key.escape) onInputUnavailable(abortTarget.kind);
      abortConfirmation.handleInput(abortTarget, key, confirmGoalOperation);
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
    if (answerTarget !== null) {
      if (questionAnswer.handleInput(key, submitInput, editorRef, saveAnswer)) return;
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
  };
  currentHandlers.current = { pasteText, handleInput };
  useInput(handleInput);
}
